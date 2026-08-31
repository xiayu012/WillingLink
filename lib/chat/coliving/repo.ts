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
  resides: boolean;
  phone: string | null;
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

/** 入站消息认人：手机号 → 这个人 + 他当前所在的 household。认不出返回 null。 */
export async function resolveSender(phone: string): Promise<Sender | null> {
  const target = normalizePhone(phone);
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
      h.dwelling_id   as "dwellingId"
    from coliving.person_contact pc
    join coliving.person p on p.id = pc.person_id
    join coliving.membership m
      on m.person_id = p.id and m.valid_to is null
    join coliving.household h
      on h.id = m.household_id and h.status = 'active'
    where pc.kind = 'sms' and pc.value = ${target}
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
export async function getMembers(householdId: string): Promise<Member[]> {
  return await db()<Member[]>`
    select
      p.id           as "personId",
      p.display_name as name,
      m.role         as role,
      m.resides      as resides,
      (select pc.value from coliving.person_contact pc
        where pc.person_id = p.id and pc.kind = 'sms'
        order by pc.is_primary desc limit 1) as phone,
      coalesce(
        (select array_agg(mem.content order by mem.created_at)
           from coliving.memory mem
          where mem.person_id = p.id
            and mem.valid_to is null
            and mem.kind in ('schedule','preference','sensitivity')),
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
    select id, kind, statement
    from coliving.rule
    where household_id = ${householdId} and status = 'active'
      and (valid_to is null or valid_to > now())
    order by kind
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
}): Promise<void> {
  await db()`
    insert into coliving.message
      (conversation_id, person_id, direction, channel, body,
       external_message_id, communication_id)
    values (${args.conversationId}, ${args.personId}, ${args.direction},
            ${args.channel}, ${args.body},
            ${args.externalMessageId ?? null}, ${args.communicationId ?? null})
    on conflict do nothing
  `;
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
}): Promise<string> {
  const rows = await db()<{ id: string }[]>`
    insert into coliving.decision
      (household_id, case_id, event_id, kind, target_person_ids, intent,
       rationale, model_id, doctrine_modules, context_chars)
    values (${args.householdId}, ${args.caseId ?? null}, ${args.eventId ?? null},
            ${args.kind}, ${db().array(args.targetPersonIds ?? [])}::uuid[],
            ${args.intent ?? null}, ${args.rationale ?? null},
            ${args.modelId ?? null},
            ${db().array(args.doctrineModules ?? [])}::text[],
            ${args.contextChars ?? null})
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

export async function noteMemory(args: {
  householdId: string;
  personId?: string | null;
  kind: string;
  content: string;
  confidence?: number | null;
  sourceEventId?: string | null;
}): Promise<void> {
  await db()`
    insert into coliving.memory
      (household_id, person_id, kind, content, confidence, source_event_id)
    values (${args.householdId}, ${args.personId ?? null}, ${args.kind},
            ${args.content}, ${args.confidence ?? 0.8},
            ${args.sourceEventId ?? null})
  `;
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
           round(st_distance(o.geog, pl.geog)::numeric)::int as "distanceM"
    from coliving.household h
    join coliving.dwelling d on d.id = h.dwelling_id
    join coliving.place pl on pl.id = d.place_id
    join coliving.observation o
      on o.geog is not null and pl.geog is not null
     and st_dwithin(o.geog, pl.geog, coalesce(o.radius_m, 500))
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
 * **现在只做关键词/三元组相似**：embedding 列已经建好，但还没有任何东西
 * 往里写向量（没接 embedding 管线）。等接上之后这里换成
 * `order by embedding <=> $q` 并保留下面的结构化前置过滤——
 * 设计稿第十一点：先按 household / 时间 / 类别筛，再按语义排序。
 */
export async function findSimilarCases(args: {
  householdId: string;
  query: string;
  kind?: string | null;
  limit?: number;
}): Promise<
  Array<{ id: string; title: string; kind: string; status: string; resolution: string | null }>
> {
  return await db()`
    select id, title, kind, status, resolution
    from coliving.case_file
    where household_id = ${args.householdId}
      and (${args.kind ?? null}::text is null or kind = ${args.kind ?? null})
      and (title % ${args.query} or ${args.query} % title
           or kind = ${args.kind ?? null})
    order by similarity(title, ${args.query}) desc, last_activity_at desc
    limit ${args.limit ?? 5}
  ` as never;
}

// ── 运维 / 调试用 ────────────────────────────────────────────────────────────

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
