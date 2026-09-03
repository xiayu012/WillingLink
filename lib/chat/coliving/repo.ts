import "server-only";

import postgres from "postgres";
import { normalizePhone } from "./phone";

/**
 * 合租房世界模型的数据访问层。
 *
 * **schema 的事实来源是 `lib/db/migrations/manual/coliving-world.sql`**，
 * 这里不再镜像一份 drizzle 定义——本模块的查询是「时间窗 + PostGIS 距离 +
 * 向量相似」这一类，手写 SQL 更清楚；再维护一份 drizzle schema 只会多一个
 * 会漂移的事实来源。public 下租房搜索那些表仍然走 drizzle，两边互不影响。
 *
 * 贯穿全模块的两条规矩（来自设计稿）：
 *   · 关系带时间范围，**改成员不覆盖旧行**，是给旧行填 valid_to 再插新行
 *   · 临时相关性运行时算，不落库成关系
 */

let client: postgres.Sql | null = null;

function db(): postgres.Sql {
  if (!client) {
    const url = process.env.POSTGRES_URL;
    if (!url) {
      throw new Error("[coliving] 没有 POSTGRES_URL");
    }
    // 无服务器环境：连接数压到很低，靠 Neon 的连接池
    client = postgres(url, { max: 2, idle_timeout: 20 });
  }
  return client;
}

export type Role = "tenant" | "landlord" | "coordinator" | "other";

export type Member = {
  personId: string;
  name: string;
  role: Role;
  /**
   * true=确认住在这里，false=确认不住，**null=不知道**。
   * 不知道就是不知道——共用资源怎么分直接取决于这个数，
   * 拿默认值顶替会让 AI 笃定地算错（见 coliving-world-05.sql）。
   */
  resides: boolean | null;
  /** 他真正搬进来的时间。null = 不知道。**不是录入时间** */
  movedInAt: Date | null;
  /**
   * 这个名字是不是真名。false = 系统给的占位名（「2号住客」这种）。
   *
   * **必须逐人标出来给模型看。** 曾经靠在提示词里写一句
   * 「名字带『新住客』字样的是占位符」来防——后来占位名格式改成
   * 「N号住客」，那句话就失效了，AI 把「2号、3号」念进了短信里。
   * 靠字符串匹配的规则会随格式漂移而静默失效，靠字段不会。
   */
  nameConfirmed: boolean;
  /**
   * 他在**当前这个渠道**里的地址：短信是手机号，企业微信是 UserID。
   * 不叫 phone 是因为这个大脑已经不只有短信了。
   */
  address: string | null;
  /** 长期记忆里关于这个人的作息/偏好，已经拼成一行 */
  notes: string[];
};

export type Sender = {
  personId: string;
  name: string;
  role: Role;
  householdId: string;
  householdLabel: string;
  dwellingId: string;
  /** 测试屋。本地进程只能写这种（见 guard.ts 里那次事故） */
  isTest: boolean;
};

export type OpenCase = {
  id: string;
  kind: string;
  title: string;
  status: string;
  severity: string | null;
  lastActivityAt: Date;
};

export type HouseRule = {
  id: string;
  kind: string;
  statement: string;
  /** 走完一轮征询的时间。null = 还没问全，只是默认在跑 */
  consultedAt: Date | null;
  agreedCount: number;
  objectedCount: number;
  /** 还没表过态的人名。**由 SQL 算好**，不让模型自己去名单里减 */
  pendingNames: string[];
};

export type PastEvent = {
  id: string;
  kind: string;
  summary: string;
  severity: string | null;
  recordedAt: Date;
  reportedBy: string | null;
  caseId: string | null;
};

// ── 认人 ────────────────────────────────────────────────────────────────────

/**
 * 入站消息认人：**渠道 + 该渠道里的地址** → 这个人 + 他当前所在的 household。
 * 认不出返回 null（调用方应当只回一句问对方是谁，不落任何记录）。
 *
 * 同一个人可以在多个渠道有地址（手机号 + 企业微信 UserID），
 * person 只有一个——身份不因换渠道而改变，跟不因搬家而改变是同一个道理。
 */
export async function resolveSender(
  channel: string,
  externalId: string
): Promise<Sender | null> {
  const target =
    channel === "sms" ? normalizePhone(externalId) : externalId.trim();
  if (!target) {
    return null;
  }
  const rows = await db()<Sender[]>`
    select
      p.id            as "personId",
      p.display_name  as name,
      m.role          as role,
      h.id            as "householdId",
      h.label         as "householdLabel",
      h.dwelling_id   as "dwellingId",
      h.is_test       as "isTest"
    from coliving.person_contact pc
    join coliving.person p on p.id = pc.person_id
    join coliving.membership m
      on m.person_id = p.id and m.valid_to is null
    join coliving.household h
      on h.id = m.household_id and h.status = 'active'
    where pc.kind = ${channel} and pc.value = ${target}
    limit 1
  `;
  return rows[0] ?? null;
}

/**
 * 当前住在/关联到这栋房子的人。
 *
 * `valid_to is null` 是「此刻生效」的意思。要问「2027年3月10日当时住着谁」，
 * 换成 `valid_from <= $t and (valid_to is null or valid_to > $t)` 即可——
 * 历史没有被覆盖，所以查得到。
 */
export async function getMembers(
  householdId: string,
  channel = "sms"
): Promise<Member[]> {
  return await db()<Member[]>`
    select
      p.id           as "personId",
      p.display_name as name,
      m.role         as role,
      m.resides      as resides,
      p.moved_in_at  as "movedInAt",
      p.name_confirmed as "nameConfirmed",
      (select pc.value from coliving.person_contact pc
        where pc.person_id = p.id and pc.kind = ${channel}
        order by pc.is_primary desc limit 1) as address,
      -- **不按 kind 过滤。** 记忆的类别是自由文本（见 coliving-world-06.sql），
      -- 这里写死白名单的话，模型记了新类别也读不出来——静默失效，
      -- 而且要到有人发现「它明明记过却不知道」时才暴露。
      -- 只排掉 summary：那是给人看的汇总，不是关于这个人的事实。
      -- **推断要标出来。** 混着读会让 AI 把自己的猜测当事实，
      -- 再基于它推新的猜测——几年下来不可逆地跑偏。
      -- 同时按 fact_to 过滤掉已经过期的事实（「这周上夜班」到期就不该再读）。
      coalesce(
        (select array_agg(
                  case when mem.basis = 'inferred'
                       then '（推测）' || mem.content
                       else mem.content end
                order by mem.created_at)
           from coliving.memory mem
          where mem.person_id = p.id
            and mem.valid_to is null
            and mem.kind <> 'summary'
            and (mem.fact_to is null or mem.fact_to > now())),
        '{}'
      ) as notes
    from coliving.membership m
    join coliving.person p on p.id = m.person_id
    where m.household_id = ${householdId} and m.valid_to is null
    order by (m.role = 'landlord'), p.display_name
  `;
}

export async function getActiveRules(householdId: string): Promise<HouseRule[]> {
  return await db()<HouseRule[]>`
    select r.id, r.kind, r.statement,
           r.consulted_at as "consultedAt",
           coalesce(array_length(r.agreed_by, 1), 0) as "agreedCount",
           coalesce(array_length(r.objected, 1), 0) as "objectedCount",
           -- **谁还没表态，由数据库算**。让模型拿名单去减人，它会算错，
           -- 而且每一轮都要重算一遍——确定性的账不该进提示词。
           coalesce((
             select array_agg(p.display_name order by p.display_name)
             from coliving.membership mb
             join coliving.person p on p.id = mb.person_id
             where mb.household_id = r.household_id
               and mb.valid_to is null
               and mb.resides is not false
               and not (p.id = any(r.agreed_by))
               and not (p.id = any(r.objected))
           ), '{}') as "pendingNames"
    from coliving.rule r
    where r.household_id = ${householdId} and r.status in ('active','proposed')
      and (r.valid_to is null or r.valid_to > now())
    order by r.kind
  `;
}

export async function getOpenCases(householdId: string): Promise<OpenCase[]> {
  return await db()<OpenCase[]>`
    select id, kind, title, status, severity,
           last_activity_at as "lastActivityAt"
    from coliving.case_file
    where household_id = ${householdId}
      and status in ('open','monitoring','waiting','escalated')
    order by last_activity_at desc
    limit 8
  `;
}

// ── 会话与消息 ───────────────────────────────────────────────────────────────

export async function getOrCreateConversation(args: {
  personId: string;
  householdId: string;
  channel: string;
}): Promise<string> {
  const rows = await db()<{ id: string }[]>`
    insert into coliving.conversation (person_id, household_id, channel)
    values (${args.personId}, ${args.householdId}, ${args.channel})
    on conflict (person_id, channel) do update
      set last_message_at = now(),
          household_id = excluded.household_id
    returning id
  `;
  return rows[0].id;
}

export async function appendMessage(args: {
  conversationId: string;
  personId: string;
  direction: "inbound" | "outbound";
  channel: string;
  body: string;
  externalMessageId?: string | null;
  communicationId?: string | null;
  /** 返回消息 id，调用方要用它把「人类回应」关联回对应的沟通 */
}): Promise<string | null> {
  const rows = await db()<{ id: string }[]>`
    insert into coliving.message
      (conversation_id, person_id, direction, channel, body,
       external_message_id, communication_id)
    values (${args.conversationId}, ${args.personId}, ${args.direction},
            ${args.channel}, ${args.body},
            ${args.externalMessageId ?? null}, ${args.communicationId ?? null})
    on conflict do nothing
    returning id
  `;
  return rows[0]?.id ?? null;
}

/**
 * 这个人有没有一条还等着他回话的沟通。**只读，不改状态。**
 *
 * 用在轮次开始时：让模型知道「他这句多半是在回你之前问的那件事」。
 * 这比事后关联更值钱——它直接防住「明明问过、他也答了，下一轮又问一遍」。
 */
export async function pendingCommunication(
  personId: string,
  withinHours = 72
): Promise<{ purpose: string | null; body: string; sentAt: Date } | null> {
  const rows = await db()<
    { purpose: string | null; body: string; sentAt: Date }[]
  >`
    select purpose, body, sent_at as "sentAt"
    from coliving.communication
    where to_person_id = ${personId}
      and status = 'sent'
      and responded_at is null
      and sent_at > now() - (${withinHours} || ' hours')::interval
    order by sent_at desc limit 1
  `;
  return rows[0] ?? null;
}

/** 最近几轮对话，按时间正序返回，喂给模型当 history */
export async function getRecentTurns(
  conversationId: string,
  limit = 12
): Promise<Array<{ role: "user" | "assistant"; content: string }>> {
  const rows = await db()<
    { direction: "inbound" | "outbound"; body: string }[]
  >`
    select direction, body from (
      select direction, body, sent_at
      from coliving.message
      where conversation_id = ${conversationId}
      order by sent_at desc
      limit ${limit}
    ) t order by sent_at asc
  `;
  return rows.map((r) => ({
    role: r.direction === "inbound" ? ("user" as const) : ("assistant" as const),
    content: r.body,
  }));
}

// ── Governance ──────────────────────────────────────────────────────────────

export async function recordEvent(args: {
  householdId: string;
  kind: string;
  summary: string;
  detail?: string | null;
  severity?: string | null;
  reportedBy?: string | null;
  aboutPersonIds?: string[];
  caseId?: string | null;
}): Promise<string> {
  const rows = await db()<{ id: string }[]>`
    insert into coliving.event
      (household_id, kind, summary, detail, severity, reported_by,
       about_person_ids, case_id)
    values (${args.householdId}, ${args.kind}, ${args.summary},
            ${args.detail ?? null}, ${args.severity ?? null},
            ${args.reportedBy ?? null},
            ${db().array(args.aboutPersonIds ?? [])}::uuid[],
            ${args.caseId ?? null})
    returning id
  `;
  return rows[0].id;
}

export async function openCase(args: {
  householdId: string;
  kind: string;
  title: string;
  severity?: string | null;
}): Promise<string> {
  const rows = await db()<{ id: string }[]>`
    insert into coliving.case_file (household_id, kind, title, severity)
    values (${args.householdId}, ${args.kind}, ${args.title},
            ${args.severity ?? null})
    returning id
  `;
  return rows[0].id;
}

export async function updateCase(args: {
  caseId: string;
  status?: string;
  resolution?: string | null;
}): Promise<void> {
  await db()`
    update coliving.case_file
    set status = coalesce(${args.status ?? null}, status),
        resolution = coalesce(${args.resolution ?? null}, resolution),
        last_activity_at = now(),
        closed_at = case when ${args.status ?? null} in ('resolved','closed')
                         then now() else closed_at end
    where id = ${args.caseId}
  `;
}

/**
 * 这个 case 真的存在吗（且属于这栋房子）。
 *
 * **模型会编 id。** 编了之后 `touchCase` 更新零行、不报错，
 * 但后面拿它去插 communication 就会撞外键，**整轮崩掉、住户什么都收不到**。
 * 所以凡是模型给的 id，用之前一律先验。
 */
export async function caseExists(
  householdId: string,
  caseId: string
): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/i.test(caseId)) {
    return false;
  }
  const rows = await db()<{ id: string }[]>`
    select id from coliving.case_file
    where id = ${caseId} and household_id = ${householdId} limit 1
  `;
  return rows.length > 0;
}

export async function touchCase(caseId: string): Promise<void> {
  await db()`
    update coliving.case_file set last_activity_at = now() where id = ${caseId}
  `;
}

export async function recordOutcome(args: {
  caseId: string;
  kind: string;
  note?: string | null;
  sentiment?: number | null;
}): Promise<void> {
  await db()`
    insert into coliving.outcome (case_id, kind, note, sentiment)
    values (${args.caseId}, ${args.kind}, ${args.note ?? null},
            ${args.sentiment ?? null})
  `;
}

/**
 * AI 的治理判断。**先于任何实际沟通落库**，与说出口的话分开存，
 * 这样以后能分别评估「判断对不对」和「表达合不合适」（设计稿第六点）。
 */
export async function recordDecision(args: {
  householdId: string;
  caseId?: string | null;
  eventId?: string | null;
  kind: string;
  targetPersonIds?: string[];
  intent?: string | null;
  rationale?: string | null;
  modelId?: string | null;
  doctrineModules?: string[];
  contextChars?: number | null;
  /** 当时喂给模型的运行时上下文原文。**判断对不对取决于它当时看到了什么** */
  contextSnapshot?: string | null;
}): Promise<string> {
  const rows = await db()<{ id: string }[]>`
    insert into coliving.decision
      (household_id, case_id, event_id, kind, target_person_ids, intent,
       rationale, model_id, doctrine_modules, context_chars,
       context_snapshot)
    values (${args.householdId}, ${args.caseId ?? null}, ${args.eventId ?? null},
            ${args.kind}, ${db().array(args.targetPersonIds ?? [])}::uuid[],
            ${args.intent ?? null}, ${args.rationale ?? null},
            ${args.modelId ?? null},
            ${db().array(args.doctrineModules ?? [])}::text[],
            ${args.contextChars ?? null}, ${args.contextSnapshot ?? null})
    returning id
  `;
  return rows[0].id;
}

/**
 * 模型常常先声明「只回复本人」，转头又去联系了别人。
 * 判断记录必须和实际行为一致，否则「AI 判断得对不对」这个复盘就没法做了。
 * 只往「介入更深」的方向改，不往回改。
 */
export async function upgradeDecisionKind(
  decisionId: string,
  kind: string
): Promise<void> {
  await db()`
    update coliving.decision set kind = ${kind}
    where id = ${decisionId}
      and kind in ('observe','stay_silent','log_only','reply_only')
  `;
}

/** Decision 产生的实际外呼。先落库（queued），发送成功再回写。 */
export async function queueCommunication(args: {
  householdId: string;
  decisionId?: string | null;
  caseId?: string | null;
  toPersonId: string;
  channel: string;
  purpose?: string | null;
  body: string;
}): Promise<string> {
  const rows = await db()<{ id: string }[]>`
    insert into coliving.communication
      (household_id, decision_id, case_id, to_person_id, channel, purpose, body)
    values (${args.householdId}, ${args.decisionId ?? null},
            ${args.caseId ?? null}, ${args.toPersonId}, ${args.channel},
            ${args.purpose ?? null}, ${args.body})
    returning id
  `;
  return rows[0].id;
}

export async function markCommunication(args: {
  communicationId: string;
  status: "sent" | "failed" | "skipped";
  externalMessageId?: string | null;
  error?: string | null;
}): Promise<void> {
  await db()`
    update coliving.communication
    set status = ${args.status},
        sent_at = case when ${args.status} = 'sent' then now() else sent_at end,
        external_message_id = ${args.externalMessageId ?? null},
        error = ${args.error ?? null}
    where id = ${args.communicationId}
  `;
}

/**
 * 记下这栋房子的一条规则。
 *
 * 同 kind 的旧规则**不删除**，而是 retire 掉——保留历史而不是覆盖历史。
 * `agreedBy` 是 Ostrom 那条：规则由住的人参与形成才活得下来，所以要记谁同意过。
 */
export async function saveRule(args: {
  householdId: string;
  kind: string;
  statement: string;
  agreedBy?: string[];
  sourceCaseId?: string | null;
}): Promise<string> {
  return await db().begin(async (tx) => {
    await tx`
      update coliving.rule
      set status = 'retired', valid_to = now()
      where household_id = ${args.householdId}
        and kind = ${args.kind}
        and status = 'active'
    `;
    const rows = await tx<{ id: string }[]>`
      insert into coliving.rule
        (household_id, kind, statement, status, agreed_by, source_case_id)
      values (${args.householdId}, ${args.kind}, ${args.statement}, 'active',
              ${tx.array(args.agreedBy ?? [])}::uuid[],
              ${args.sourceCaseId ?? null})
      returning id
    `;
    return rows[0].id;
  });
}

/**
 * 记一条长期记忆。
 *
 * ## 三件事必须分开，否则记忆会被自己污染
 *
 * **basis**：`stated` 当事人自己说的 · `observed` 系统观察到的 ·
 * `inferred` **你推出来的**。「我上夜班」是 stated，
 * 「所以他白天睡觉」是 inferred。混在一起存，几年下来 AI 会把自己的
 * 猜测读回去当事实、再基于它推新的——**不可逆地越跑越偏**。
 *
 * **subjectKey**：同一个人 + 同一个主题只留一条当前有效。
 * 3 月说「11点睡」、8 月说「凌晨3点回」不是两条并列的记忆，
 * 是后者**取代**前者。按主题键取代比按文本相似度可靠得多——
 * 中文改写的三元组相似度会掉到 0.05，根本认不出是同一件事。
 *
 * **factFrom / factTo**：这条事实在**世界里**的有效期，
 * 跟 valid_from/valid_to（记录的有效期）是两回事。
 * 「这周上夜班」和「长期上夜班」的 factTo 完全不同。
 *
 * 取代不删除：旧行填 valid_to + superseded_by，
 * 这样才答得出「他什么时候改的作息」。
 */
export async function noteMemory(args: {
  householdId: string;
  personId?: string | null;
  kind: string;
  content: string;
  /** 默认 stated。**推断一定要显式填 inferred** */
  basis?: "stated" | "observed" | "inferred";
  /** 谁说的。可能不是这条记忆的主人（室友转述） */
  statedBy?: string | null;
  /** 主题键，同人同主题只留一条当前有效 */
  subjectKey?: string | null;
  factFrom?: Date | null;
  factTo?: Date | null;
  confidence?: number | null;
  sourceEventId?: string | null;
  /** 语义召回用。算不出来就不给，不影响写入 */
  embedding?: number[] | null;
}): Promise<string> {
  const basis = args.basis ?? "stated";
  return await db().begin(async (tx) => {
    const [row] = await tx<{ id: string }[]>`
      insert into coliving.memory
        (household_id, person_id, kind, content, basis, stated_by,
         subject_key, fact_from, fact_to, confidence, source_event_id, embedding)
      values (${args.householdId}, ${args.personId ?? null}, ${args.kind},
              ${args.content}, ${basis}, ${args.statedBy ?? null},
              ${args.subjectKey ?? null}, ${args.factFrom ?? null},
              ${args.factTo ?? null},
              ${args.confidence ?? (basis === "inferred" ? 0.5 : 0.85)},
              ${args.sourceEventId ?? null},
              ${args.embedding ? `[${args.embedding.join(",")}]` : null}::vector)
      returning id
    `;

    if (args.personId && args.subjectKey) {
      // 同人同主题的旧记忆被取代。**不删**——留着才答得出「他什么时候改的」
      await tx`
        update coliving.memory
        set valid_to = now(), superseded_by = ${row.id}
        where person_id = ${args.personId}
          and subject_key = ${args.subjectKey}
          and valid_to is null
          and id <> ${row.id}
      `;
    } else if (args.personId) {
      // 没给主题键时退回文本相似度。**弱**：中文改写会掉到 0.05，
      // 所以工具描述里要求模型尽量给 subjectKey
      await tx`
        update coliving.memory
        set valid_to = now(), superseded_by = ${row.id}
        where person_id = ${args.personId} and valid_to is null
          and id <> ${row.id}
          and similarity(content, ${args.content}) > 0.2
      `;
    }

    if (args.personId) {
      // 总量闸：notes 每轮都进上下文，没上限的话用得越久提示词越肿
      await tx`
        update coliving.memory set valid_to = now()
        where id in (
          select id from coliving.memory
          where person_id = ${args.personId} and valid_to is null
          order by created_at desc offset 10
        )
      `;
    }
    return row.id;
  });
}

/**
 * 语义召回长期记忆。**「之前是不是也发生过类似的事」用 SQL 查不了**——
 * 说法千变万化（半夜切菜／凌晨有人／别晚上做饭／宵夜吵醒我），
 * 字面完全不同但说的是一件事。这是向量该干的活。
 */
export async function recallMemories(args: {
  householdId: string;
  queryVector: number[];
  limit?: number;
}): Promise<
  Array<{ who: string | null; kind: string; content: string; basis: string }>
> {
  const vec = `[${args.queryVector.join(",")}]`;
  return await db()`
    select p.display_name as who, m.kind, m.content, m.basis
    from coliving.memory m
    left join coliving.person p on p.id = m.person_id
    where m.household_id = ${args.householdId}
      and m.embedding is not null
    order by m.embedding <=> ${vec}::vector
    limit ${args.limit ?? 5}
  ` as never;
}

// ── 按需展开的查询（Context Builder 默认不带，模型要了才查）──────────────────

export async function lookupEvents(args: {
  householdId: string;
  aboutPersonId?: string | null;
  kind?: string | null;
  sinceDays?: number;
  limit?: number;
}): Promise<PastEvent[]> {
  const since = args.sinceDays ?? 180;
  const limit = args.limit ?? 10;
  return await db()<PastEvent[]>`
    select e.id, e.kind, e.summary, e.severity,
           e.recorded_at as "recordedAt",
           p.display_name as "reportedBy",
           e.case_id as "caseId"
    from coliving.event e
    left join coliving.person p on p.id = e.reported_by
    where e.household_id = ${args.householdId}
      and e.recorded_at > now() - (${since} || ' days')::interval
      and (${args.kind ?? null}::text is null or e.kind = ${args.kind ?? null})
      and (${args.aboutPersonId ?? null}::uuid is null
           or ${args.aboutPersonId ?? null}::uuid = any(e.about_person_ids)
           or e.reported_by = ${args.aboutPersonId ?? null}::uuid)
    order by e.recorded_at desc
    limit ${limit}
  `;
}

/**
 * 附近的环境观察 —— 设计稿第三、四点的落地。
 *
 * 「Kevin 和这个臭味有关」不落库，而是在这里按**空间 + 时间**动态推算：
 * 房子的坐标 ↔ 观察的坐标在影响半径内，且时间窗重合。
 * 房子没填经纬度时这个查询自然返回空，不报错。
 */
export async function nearbyObservations(args: {
  householdId: string;
  kind?: string | null;
  at: Date;
  windowMinutes?: number;
}): Promise<
  Array<{
    kind: string;
    summary: string | null;
    observedAt: Date;
    severity: number | null;
    confidence: number | null;
    distanceM: number;
  }>
> {
  const win = args.windowMinutes ?? 180;
  return await db()`
    select o.kind, o.summary, o.observed_at as "observedAt",
           o.severity, o.confidence,
           coalesce(round(st_distance(o.geog, pl.geog)::numeric)::int, 0)
             as "distanceM"
    from coliving.household h
    join coliving.dwelling d on d.id = h.dwelling_id
    join coliving.place pl on pl.id = d.place_id
    -- 两种匹配都算：
    --   ① 有经纬度时按距离（外部数据源、传感器）
    --   ② **没经纬度时按同一个地点**（住户自己报的，我们通常只知道「这栋房子」）
    -- 只留 ① 的话，住户报的观察永远查不出来——表写了也白写。
    join coliving.observation o
      on (
           (o.geog is not null and pl.geog is not null
            and st_dwithin(o.geog, pl.geog, coalesce(o.radius_m, 500)))
        or (o.geog is null and o.place_id = pl.id)
         )
    where h.id = ${args.householdId}
      and (${args.kind ?? null}::text is null or o.kind = ${args.kind ?? null})
      and o.observed_at between
            ${args.at}::timestamptz - (${win} || ' minutes')::interval
        and ${args.at}::timestamptz + (${win} || ' minutes')::interval
    order by o.observed_at desc
    limit 5
  ` as never;
}

/**
 * 找相似的历史 Case。
 *
 * 设计稿第十一点：**向量只是普通查询之外的一种检索方式**，不是数据库结构本身。
 * 所以这里先做结构化前置过滤（同一栋房子、可选类别），再按语义排序——
 * 而不是拿一个向量去全库捞。
 *
 * 没有向量（还没算过 embedding）时自动退回 pg_trgm 关键词相似，不报错。
 */
export async function findSimilarCases(args: {
  householdId: string;
  query: string;
  queryVector?: number[] | null;
  kind?: string | null;
  limit?: number;
}): Promise<
  Array<{
    id: string;
    title: string;
    kind: string;
    status: string;
    resolution: string | null;
    score: number | null;
  }>
> {
  const limit = args.limit ?? 5;
  if (args.queryVector?.length) {
    const vec = `[${args.queryVector.join(",")}]`;
    return await db()`
      select id, title, kind, status, resolution,
             round((1 - (embedding <=> ${vec}::vector))::numeric, 3)::float as score
      from coliving.case_file
      where household_id = ${args.householdId}
        and embedding is not null
        and (${args.kind ?? null}::text is null or kind = ${args.kind ?? null})
      order by embedding <=> ${vec}::vector
      limit ${limit}
    ` as never;
  }
  return await db()`
    select id, title, kind, status, resolution,
           round(similarity(title, ${args.query})::numeric, 3)::float as score
    from coliving.case_file
    where household_id = ${args.householdId}
      and (${args.kind ?? null}::text is null or kind = ${args.kind ?? null})
      and (title % ${args.query} or kind = ${args.kind ?? null})
    order by similarity(title, ${args.query}) desc, last_activity_at desc
    limit ${limit}
  ` as never;
}

/** 检索治理资料/判例（Knowledge 域）。同样先结构化后语义。 */
export async function searchKnowledge(args: {
  queryVector: number[];
  kind?: string | null;
  jurisdiction?: string | null;
  limit?: number;
}): Promise<Array<{ title: string; body: string; score: number }>> {
  const vec = `[${args.queryVector.join(",")}]`;
  return await db()`
    select d.title, c.body,
           round((1 - (c.embedding <=> ${vec}::vector))::numeric, 3)::float as score
    from coliving.knowledge_chunk c
    join coliving.knowledge_doc d on d.id = c.doc_id
    where c.embedding is not null
      and (${args.kind ?? null}::text is null or d.kind = ${args.kind ?? null})
      and (${args.jurisdiction ?? null}::text is null
           or d.jurisdiction = ${args.jurisdiction ?? null})
    order by c.embedding <=> ${vec}::vector
    limit ${args.limit ?? 4}
  ` as never;
}

export async function setCaseEmbedding(
  caseId: string,
  vector: number[]
): Promise<void> {
  await db()`
    update coliving.case_file
    set embedding = ${`[${vector.join(",")}]`}::vector
    where id = ${caseId}
  `;
}

/** 还没算过向量的 Case，供离线补算 */
export async function casesMissingEmbedding(
  limit = 50
): Promise<Array<{ id: string; title: string; kind: string; resolution: string | null }>> {
  return await db()`
    select id, title, kind, resolution from coliving.case_file
    where embedding is null order by last_activity_at desc limit ${limit}
  ` as never;
}

/**
 * 改名。AI 在对话里听出真名时用——**不是让住户填表**，
 * 是它自己听出来的。`confirmed` 表示这名字是本人说的，不是我们编的。
 */
export async function renamePerson(args: {
  personId: string;
  name: string;
  confirmed?: boolean;
}): Promise<void> {
  await db()`
    update coliving.person
    set display_name = ${args.name},
        name_confirmed = ${args.confirmed ?? true},
        updated_at = now()
    where id = ${args.personId}
  `;
}

// ── 开张与加人 ──────────────────────────────────────────────────────────────

/**
 * 房东入库：没有房子就开一栋，把他放进去当 landlord。
 *
 * **这是整个系统的起点。** 用户先认识房东、先有房东的号码，
 * 剩下的住户号码由 AI 从房东那里问出来（`addResident`）。
 * 幂等：同一个号码重复调用不会重复建人。
 */
export async function enrollLandlord(args: {
  phone: string;
  label?: string | null;
}): Promise<{ personId: string; householdId: string; created: boolean }> {
  const phone = normalizePhone(args.phone);
  if (!phone) {
    throw new Error("[coliving] 手机号无法解析");
  }
  return await db().begin(async (tx) => {
    const [existing] = await tx<{ person_id: string; household_id: string }[]>`
      select pc.person_id, m.household_id
      from coliving.person_contact pc
      join coliving.membership m
        on m.person_id = pc.person_id and m.valid_to is null
      where pc.kind = 'sms' and pc.value = ${phone}
      limit 1`;
    if (existing) {
      return {
        personId: existing.person_id,
        householdId: existing.household_id,
        created: false,
      };
    }

    const label = args.label?.trim() || "这栋房子";
    const [place] = await tx<{ id: string }[]>`
      insert into coliving.place (kind, label, country)
      values ('dwelling', ${label}, 'US') returning id`;
    const [dw] = await tx<{ id: string }[]>`
      insert into coliving.dwelling (place_id, label)
      values (${place.id}, ${label}) returning id`;
    const [h] = await tx<{ id: string }[]>`
      insert into coliving.household (dwelling_id, label)
      values (${dw.id}, ${label}) returning id`;
    await tx`
      insert into coliving.household_epoch (household_id, seq, label, started_at)
      values (${h.id}, 1, '开张', now())`;

    const [p] = await tx<{ id: string }[]>`
      insert into coliving.person (display_name, onboarded_at)
      values ('房东', now()) returning id`;
    await tx`
      insert into coliving.person_contact (person_id, kind, value, is_primary)
      values (${p.id}, 'sms', ${phone}, true)`;
    // resides 默认 true —— 房东完全可能住在自己房子里，这是事实不是角色推导。
    // 不确定时按住着算，AI 聊出来再改。
    await tx`
      insert into coliving.membership (household_id, person_id, role, resides)
      values (${h.id}, ${p.id}, 'landlord', true)`;

    return { personId: p.id, householdId: h.id, created: true };
  });
}

/**
 * 加一个住户。**AI 从对话里拿到号码时调用**——房东把室友号码发过来，
 * 它就一个个加进来，不需要任何人填表。
 *
 * 名字先占位；真名在往后的对话里听出来再改（renamePerson）。
 */
export async function addResident(args: {
  householdId: string;
  phone: string;
  name?: string | null;
  role?: Role;
  note?: string | null;
}): Promise<{ personId: string; created: boolean }> {
  const phone = normalizePhone(args.phone);
  if (!phone) {
    throw new Error("手机号无法解析");
  }
  return await db().begin(async (tx) => {
    const [existing] = await tx<{ person_id: string }[]>`
      select person_id from coliving.person_contact
      where kind = 'sms' and value = ${phone} limit 1`;
    if (existing) {
      const [inHouse] = await tx<{ id: string }[]>`
        select id from coliving.membership
        where household_id = ${args.householdId}
          and person_id = ${existing.person_id} and valid_to is null limit 1`;
      if (inHouse) {
        return { personId: existing.person_id, created: false };
      }
      await tx`
        insert into coliving.membership (household_id, person_id, role, resides)
        values (${args.householdId}, ${existing.person_id},
                ${args.role ?? "tenant"}, true)`;
      return { personId: existing.person_id, created: false };
    }

    // 占位名按人数编号，但**模型会并行调多次 addResident**——
    // 两个事务同时读到同样的 count，两个人都叫「2号住客」，
    // findPersonByName 就分不清了。用事务级咨询锁按房子串行化。
    await tx`select pg_advisory_xact_lock(hashtext(${args.householdId}))`;
    const [n] = await tx<{ c: number }[]>`
      select count(*)::int as c from coliving.membership
      where household_id = ${args.householdId} and valid_to is null`;
    const [p] = await tx<{ id: string }[]>`
      insert into coliving.person (display_name, onboarded_at)
      values (${args.name?.trim() || `${n.c + 1}号住客`}, now()) returning id`;
    await tx`
      insert into coliving.person_contact (person_id, kind, value, is_primary)
      values (${p.id}, 'sms', ${phone}, true)`;
    await tx`
      insert into coliving.membership (household_id, person_id, role, resides, note)
      values (${args.householdId}, ${p.id}, ${args.role ?? "tenant"}, true,
              ${args.note ?? null})`;
    return { personId: p.id, created: true };
  });
}

// ── 成员变更（换人）─────────────────────────────────────────────────────────
// **不覆盖历史**：搬走是给旧行填 valid_to，搬进是插新行；
// 成员结构一变就开一个新 epoch，用来分辨「这栋房子长期如此」
// 还是「某一批人凑在一起才出问题」。

async function rollEpoch(
  tx: postgres.TransactionSql,
  householdId: string,
  label: string
): Promise<void> {
  const [cur] = await tx<{ seq: number }[]>`
    select coalesce(max(seq), 0) as seq from coliving.household_epoch
    where household_id = ${householdId}
  `;
  await tx`
    update coliving.household_epoch set ended_at = now()
    where household_id = ${householdId} and ended_at is null
  `;
  await tx`
    insert into coliving.household_epoch (household_id, seq, label, started_at)
    values (${householdId}, ${cur.seq + 1}, ${label}, now())
  `;
}

export async function moveOut(args: {
  householdId: string;
  personId: string;
  reason?: string | null;
}): Promise<void> {
  await db().begin(async (tx) => {
    await tx`
      update coliving.membership set valid_to = now(),
        note = coalesce(note || ' / ', '') || ${args.reason ?? "搬出"}
      where household_id = ${args.householdId}
        and person_id = ${args.personId} and valid_to is null
    `;
    const [p] = await tx<{ display_name: string }[]>`
      select display_name from coliving.person where id = ${args.personId}
    `;
    await rollEpoch(tx, args.householdId, `${p?.display_name ?? "某人"} 搬出后`);
    // 他个人的偏好记忆也随之失效——那是关于「他住在这里时」的事实
    await tx`
      update coliving.memory set valid_to = now()
      where person_id = ${args.personId} and household_id = ${args.householdId}
        and valid_to is null
    `;
  });
}

export async function moveIn(args: {
  householdId: string;
  name: string;
  phone: string;
  role?: Role;
  /**
   * 住不住在这里。**必须显式给，不要从 role 推。**
   * 曾经写成 `role !== 'landlord'`，结果同住的房东被算成不住这儿，
   * 三个人的厨房被按两个人分了。房东完全可以住在自己房子里——
   * 他要是住这儿，共用资源就得算他一份，共同规则他也是一票。
   */
  resides?: boolean;
  note?: string | null;
}): Promise<string> {
  const phone = normalizePhone(args.phone);
  return await db().begin(async (tx) => {
    // 同一个手机号可能是老住户搬回来——复用同一个 person，身份不因搬家而改变
    const [existing] = await tx<{ person_id: string }[]>`
      select person_id from coliving.person_contact
      where kind = 'sms' and value = ${phone} limit 1
    `;
    let personId: string;
    if (existing) {
      personId = existing.person_id;
    } else {
      const [p] = await tx<{ id: string }[]>`
        insert into coliving.person (display_name, onboarded_at)
        values (${args.name}, now()) returning id
      `;
      personId = p.id;
      await tx`
        insert into coliving.person_contact (person_id, kind, value, is_primary)
        values (${personId}, 'sms', ${phone}, true)
      `;
    }
    await tx`
      insert into coliving.membership
        (household_id, person_id, role, resides, note)
      values (${args.householdId}, ${personId}, ${args.role ?? "tenant"},
              ${args.resides ?? true}, ${args.note ?? null})
      on conflict do nothing
    `;
    await tx`
      update coliving.person set onboarded_at = now()
      where id = ${personId} and onboarded_at is null
    `;
    await rollEpoch(tx, args.householdId, `${args.name} 搬入后`);
    return personId;
  });
}

// ── 共识规则：问过谁、谁同意、谁有异议 ───────────────────────────────────────

export type PendingRule = {
  id: string;
  kind: string;
  statement: string;
  consulted: string[];
  agreedBy: string[];
  objected: string[];
};

/** 还没走完一轮征询的规则——主动发起的 cron 靠它找活干 */
export async function rulesNeedingConsult(
  householdId: string
): Promise<PendingRule[]> {
  return await db()<PendingRule[]>`
    select id, kind, statement,
           consulted as "consulted", agreed_by as "agreedBy", objected as "objected"
    from coliving.rule
    where household_id = ${householdId}
      and status in ('proposed','active')
      and consulted_at is null
    order by valid_from
  `;
}

export async function recordConsultation(args: {
  ruleId: string;
  personId: string;
  stance: "asked" | "agreed" | "objected";
}): Promise<void> {
  // 表过态的人一律进 consulted；agreed/objected 再各自加一列。
  // **不能把两条 set 拼成一句**——stance=asked 时两边都是 consulted，
  // PostgreSQL 会报「multiple assignments to same column」，
  // 整个工具调用静默失败（真实 bug，问过 0 人就是这么来的）。
  const p = `{${args.personId}}`;
  await db()`
    update coliving.rule
    set consulted = (select array_agg(distinct x)
                     from unnest(consulted || ${p}::uuid[]) x)
    where id = ${args.ruleId}
  `;
  if (args.stance === "agreed") {
    await db()`
      update coliving.rule
      set agreed_by = (select array_agg(distinct x)
                       from unnest(agreed_by || ${p}::uuid[]) x),
          objected = array_remove(objected, ${args.personId}::uuid)
      where id = ${args.ruleId}
    `;
  } else if (args.stance === "objected") {
    await db()`
      update coliving.rule
      set objected = (select array_agg(distinct x)
                      from unnest(objected || ${p}::uuid[]) x),
          agreed_by = array_remove(agreed_by, ${args.personId}::uuid)
      where id = ${args.ruleId}
    `;
  }
}

/** 所有在住的人都问过了 → 这条规则算走完一轮，正式成立 */
export async function closeConsultation(ruleId: string): Promise<void> {
  await db()`
    update coliving.rule set consulted_at = now(), status = 'active'
    where id = ${ruleId}
  `;
}

/**
 * 表态齐了就自动收口。**由代码判断，不靠模型**。
 *
 * 这类「状态读得到、但没人做那个收尾动作」的 bug 已经犯过三次：
 * `roster_complete` 读了没人写、`name_confirmed` 写了没人读、
 * 现在是征询完成没人合。表现都一样——AI 被提示词一直催着去问，
 * 问到了也没处收，于是下一轮接着问。
 *
 * 判据是确定性的：名册上没有 `resides = false` 的人里，
 * 每一个都出现在 agreed_by 或 objected 里。
 */
export async function closeConsultationIfComplete(
  ruleId: string
): Promise<boolean> {
  const rows = await db()<{ id: string }[]>`
    update coliving.rule r
    set consulted_at = now(), status = 'active'
    where r.id = ${ruleId}
      and r.consulted_at is null
      and not exists (
        select 1 from coliving.membership mb
        join coliving.person p on p.id = mb.person_id
        where mb.household_id = r.household_id
          and mb.valid_to is null
          and mb.resides is not false
          and not (p.id = any(r.agreed_by))
          and not (p.id = any(r.objected))
      )
    returning r.id
  `;
  return rows.length > 0;
}

// ── 主动发起的候选 ───────────────────────────────────────────────────────────

/** 冷了太久还没了结的事 */
export async function casesNeedingFollowup(args: {
  householdId: string;
  staleDays?: number;
  minGapDays?: number;
}): Promise<OpenCase[]> {
  return await db()<OpenCase[]>`
    select id, kind, title, status, severity, last_activity_at as "lastActivityAt"
    from coliving.case_file
    where household_id = ${args.householdId}
      and status in ('open','monitoring','waiting')
      and last_activity_at < now() - (${args.staleDays ?? 3} || ' days')::interval
      and (last_followup_at is null
           or last_followup_at < now() - (${args.minGapDays ?? 5} || ' days')::interval)
      and followup_count < 3
    order by last_activity_at
    limit 3
  `;
}

export async function markFollowedUp(caseId: string): Promise<void> {
  await db()`
    update coliving.case_file
    set last_followup_at = now(), followup_count = followup_count + 1
    where id = ${caseId}
  `;
}

/**
 * **刚录入系统两周内的人**——注意不是「刚搬进来的人」。
 *
 * 曾经把这两件事混为一谈：`onboarded_at` 记的是我们什么时候把人放进系统，
 * 提示词读成了入住时间，于是 AI 对一个住了三年的租客说
 * 「刚搬进来这几天住得还顺吗」。真正的入住时间在 `person.moved_in_at`，
 * 只有问出来才有，默认是 null。
 *
 * 这个窗口仍然值得主动接触——**因为我们刚认识他**，不是因为他刚搬来。
 */
export async function recentlyAdded(householdId: string): Promise<Member[]> {
  const rows = await getMembers(householdId);
  const all = await db()<{ id: string; onboarded_at: Date | null; last_outreach_at: Date | null; proactive_ok: boolean }[]>`
    select id, onboarded_at, last_outreach_at, proactive_ok from coliving.person
    where onboarded_at > now() - interval '14 days'
  `;
  const ok = new Set(
    all
      .filter(
        (p) =>
          p.proactive_ok &&
          (!p.last_outreach_at ||
            Date.now() - p.last_outreach_at.getTime() > 3 * 24 * 3600 * 1000)
      )
      .map((p) => p.id)
  );
  return rows.filter((m) => ok.has(m.personId));
}

/**
 * 给某人在某渠道登记地址。同一渠道同一地址只能属于一个人（唯一索引兜着），
 * 重复登记同一个人是幂等的。
 */
export async function addContact(args: {
  personId: string;
  kind: string;
  value: string;
}): Promise<void> {
  const value = args.kind === "sms" ? normalizePhone(args.value) : args.value.trim();
  await db()`
    insert into coliving.person_contact (person_id, kind, value, is_primary)
    values (${args.personId}, ${args.kind}, ${value}, false)
    on conflict (kind, value) do update set person_id = excluded.person_id
  `;
}

/** 改「住不住在这里」。房东可能就住在自己房子里，这是事实不是角色推导。 */
export async function setResides(args: {
  householdId: string;
  personId: string;
  resides: boolean;
}): Promise<void> {
  await db()`
    update coliving.membership set resides = ${args.resides}
    where household_id = ${args.householdId} and person_id = ${args.personId}
      and valid_to is null
  `;
}

export async function canReachProactively(personId: string): Promise<boolean> {
  const [p] = await db()<{ ok: boolean }[]>`
    select (proactive_ok and (last_outreach_at is null
            or last_outreach_at < now() - interval '2 days')) as ok
    from coliving.person where id = ${personId}
  `;
  return p?.ok ?? false;
}

export async function markOutreach(personId: string): Promise<void> {
  await db()`
    update coliving.person set last_outreach_at = now() where id = ${personId}
  `;
}

export async function setProactiveOk(
  personId: string,
  ok: boolean
): Promise<void> {
  await db()`
    update coliving.person set proactive_ok = ${ok} where id = ${personId}
  `;
}

export async function startOutreachRun(args: {
  householdId: string;
  job: string;
}): Promise<string> {
  const rows = await db()<{ id: string }[]>`
    insert into coliving.outreach_run (household_id, job)
    values (${args.householdId}, ${args.job}) returning id
  `;
  return rows[0].id;
}

export async function finishOutreachRun(args: {
  runId: string;
  considered: number;
  acted: number;
  skipped?: Record<string, unknown>;
  error?: string | null;
}): Promise<void> {
  await db()`
    update coliving.outreach_run
    set finished_at = now(), considered = ${args.considered},
        acted = ${args.acted},
        skipped_reason = ${JSON.stringify(args.skipped ?? {})}::jsonb,
        error = ${args.error ?? null}
    where id = ${args.runId}
  `;
}

// ── 运维 / 调试用 ────────────────────────────────────────────────────────────

/**
 * 名册确认过完整没有。**默认 false**——房东给几个号码我们就有几个，
 * 不代表这栋房子只住这几个人。共用资源怎么分直接建立在这个数上，
 * 所以不确认就不能笃定地说「三个人分」。
 */
export async function isRosterComplete(householdId: string): Promise<boolean> {
  const [h] = await db()<{ roster_complete: boolean }[]>`
    select roster_complete from coliving.household where id = ${householdId}
  `;
  return h?.roster_complete ?? false;
}

/**
 * 最近发给**这栋房子里每个人**的消息（不只是当前这条会话线）。
 *
 * 没有这个，AI 只看得见跟当前这个人的往来，**根本不知道自己刚给别人
 * 发过什么**。真实后果：房东每说一句就触发一轮，每轮都去问 2号
 * 「你几点做饭」，一连问了四次，其中两次是在人家已经答过之后。
 */
export async function recentOutbound(
  householdId: string,
  limit = 12
): Promise<
  Array<{ to: string; body: string; sentAt: Date; direction: string }>
> {
  return await db()`
    select p.display_name as "to", m.body, m.sent_at as "sentAt", m.direction
    from coliving.message m
    join coliving.conversation c on c.id = m.conversation_id
    join coliving.person p on p.id = m.person_id
    where c.household_id = ${householdId}
    order by m.sent_at desc
    limit ${limit}
  ` as never;
}

export async function setRosterComplete(
  householdId: string,
  complete: boolean
): Promise<void> {
  await db()`
    update coliving.household set roster_complete = ${complete}
    where id = ${householdId}
  `;
}

/** 记下某人真正搬进来的时间——**问出来才填**，不是录入时间 */
export async function setMovedInAt(
  personId: string,
  movedInAt: Date
): Promise<void> {
  await db()`
    update coliving.person set moved_in_at = ${movedInAt}, updated_at = now()
    where id = ${personId}
  `;
}

export async function isTestHousehold(householdId: string): Promise<boolean> {
  const [h] = await db()<{ is_test: boolean }[]>`
    select is_test from coliving.household where id = ${householdId}
  `;
  return h?.is_test ?? false;
}

/**
 * 开一栋测试屋。**本地脚本只能写这种。**
 * 真人住的房子由 `/api/coliving/enroll` 从房东号码建起，永远 is_test = false。
 */
export async function createTestHousehold(
  label = "测试屋"
): Promise<{ householdId: string }> {
  return await db().begin(async (tx) => {
    const [place] = await tx<{ id: string }[]>`
      insert into coliving.place (kind, label, country)
      values ('dwelling', ${label}, 'US') returning id`;
    const [dw] = await tx<{ id: string }[]>`
      insert into coliving.dwelling (place_id, label)
      values (${place.id}, ${label}) returning id`;
    const [h] = await tx<{ id: string }[]>`
      insert into coliving.household (dwelling_id, label, is_test)
      values (${dw.id}, ${label}, true) returning id`;
    await tx`
      insert into coliving.household_epoch (household_id, seq, label, started_at)
      values (${h.id}, 1, '开张', now())`;
    return { householdId: h.id };
  });
}

export async function listHouseholds(): Promise<
  Array<{ id: string; label: string }>
> {
  return await db()<{ id: string; label: string }[]>`
    select id, label from coliving.household
    where status = 'active' order by created_at
  `;
}

/**
 * 一条时间线：Event / Decision / Communication / Outcome 混排。
 * 这就是设计稿第十四点想留下的那条链，用来复盘「判断对不对、表达合不合适」。
 */
export async function recentActivity(
  householdId: string,
  limit = 30
): Promise<
  Array<{ at: Date; layer: string; label: string; detail: string | null }>
> {
  return await db()`
    select * from (
      select e.recorded_at as at, 'EVENT' as layer,
             (e.kind || coalesce(' /' || e.severity, '')) as label,
             e.summary as detail
        from coliving.event e where e.household_id = ${householdId}
      union all
      select d.decided_at, 'DECIDE', d.kind, coalesce(d.intent, d.rationale)
        from coliving.decision d where d.household_id = ${householdId}
      union all
      select c.created_at, 'COMM',
             (c.status || ' → ' || p.display_name), c.body
        from coliving.communication c
        join coliving.person p on p.id = c.to_person_id
       where c.household_id = ${householdId}
      union all
      select o.observed_at, 'OUTCOME', o.kind, o.note
        from coliving.outcome o
        join coliving.case_file cf on cf.id = o.case_id
       where cf.household_id = ${householdId}
    ) t order by at desc limit ${limit}
  ` as never;
}

export async function findPersonByName(
  householdId: string,
  name: string
): Promise<Member | null> {
  const members = await getMembers(householdId);
  const trimmed = name.trim();
  return (
    members.find((m) => m.name === trimmed) ??
    members.find((m) => trimmed.includes(m.name) || m.name.includes(trimmed)) ??
    null
  );
}

/**
 * 把住户刚发来的这条消息，关联到**是哪条沟通引出来的**。
 *
 * 设计稿第十四点那条链里的「Human Response」那一环。
 * **刻意不交给模型判断**：这是确定性的时间与收件人匹配，代码做得又准又免费；
 * 交给模型只会时灵时不灵，而这条链断了就再也补不回来。
 *
 * 判据：这个人最近一条**已发出、还没人回应**的沟通，且在时间窗内。
 * 超过窗口就当他不是在回那条，宁可不关联也不要错关联。
 */
export async function linkResponse(args: {
  personId: string;
  messageId: string;
  withinHours?: number;
}): Promise<{ communicationId: string; purpose: string | null } | null> {
  const rows = await db()<
    { communicationId: string; purpose: string | null }[]
  >`
    update coliving.communication
    set responded_at = now(), response_message_id = ${args.messageId}
    where id = (
      select id from coliving.communication
      where to_person_id = ${args.personId}
        and status = 'sent'
        and responded_at is null
        and sent_at > now() - (${args.withinHours ?? 72} || ' hours')::interval
      order by sent_at desc
      limit 1
    )
    returning id as "communicationId", purpose
  `;
  return rows[0] ?? null;
}

/**
 * 记一条环境观察。**属于地点和时间，不属于某个人**（设计稿第三点）。
 *
 * 住户说「外面今天特别臭」——这既是一个 Event（他报告了这件事），
 * 也是一条关于**这个地点**的观察。后者能长期留在这个地点上：
 * 几年后住户全换了，这栋房子的环境史还在；
 * 附近几栋房子也能共用同一条外部事件。
 */
export async function recordObservation(args: {
  householdId: string;
  kind: string;
  summary: string;
  observedAt?: Date | null;
  endsAt?: Date | null;
  severity?: number | null;
  source?: "resident" | "sensor" | "external" | "inferred";
  sourcePersonId?: string | null;
}): Promise<string> {
  const rows = await db()<{ id: string }[]>`
    insert into coliving.observation
      (kind, place_id, observed_at, ends_at, severity, confidence,
       source, source_person_id, summary)
    select ${args.kind}, d.place_id,
           ${args.observedAt ?? new Date()}, ${args.endsAt ?? null},
           ${args.severity ?? null},
           ${args.source === "resident" ? 0.7 : 0.9},
           ${args.source ?? "resident"}, ${args.sourcePersonId ?? null},
           ${args.summary}
    from coliving.household h
    join coliving.dwelling d on d.id = h.dwelling_id
    where h.id = ${args.householdId}
    returning id
  `;
  return rows[0].id;
}
