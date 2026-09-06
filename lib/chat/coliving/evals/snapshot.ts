import "server-only";

import postgres from "postgres";

/**
 * 数据库状态快照 / 恢复 —— 真正的 Conversation Replay 底座。
 *
 * ## 跟现有 eval 的分工
 *
 * `scripts/coliving-eval.ts` 的场景是**从零把对话演一遍**：建空测试屋，
 * 把历史消息一条条重新喂给 `runColivingTurn`。问题是多轮场景里，
 * 中间某一轮新代码的反应跟当年不一样，后面几轮就跟着分叉——最后测的是
 * "新代码对一整条被重新演绎的对话的处理"，不是"新代码对那个历史时刻的处理"。
 *
 * 这里做的是另一回事：**把某个时刻的完整世界状态冻起来**（人、成员关系、
 * 未结的事、规则、记忆、历史消息、在等谁回话），恢复进一栋全新测试屋，
 * 然后只喂最后那一条消息，问"新版会怎么处理这一步"。中间轮次不重新生成，
 * 没有分叉，信号是干净的。
 *
 * ## 三条安全性质（不是建议，是这个模块存在的前提）
 *
 * 1. **capture 全程只读**——所以可以直接对着真实住户的房子抓快照，
 *    那正是它的用途。抓取不写任何东西。
 * 2. **restore 永远建一栋新的 `is_test = true` 房子**，绝不往已存在的
 *    household 里灌。恢复出来的副本天然满足 `guard.ts` 的第二条闸。
 * 3. **手机号强制重映射到测试号段**。这条既是隐私要求也是正确性要求：
 *    `person_contact` 上有 `(kind, value)` 唯一索引，原样恢复真实号码
 *    会直接撞索引插不进去；更危险的是**万一插进去了，真实用户发来的
 *    短信会认到这个测试人格上**——那就是 guard.ts 记的那类事故的翻版。
 *
 * ## 为什么用 information_schema 动态发现列
 *
 * 这套 schema 是手写 SQL、15 个 migration 叠上来的（`repo.ts` 开头讲了
 * 为什么不镜像 drizzle）。在这里再手抄一份列清单，等于又造一个会漂移的
 * 事实来源——加一列忘了同步，快照就静默少一列。改成运行时问库要列名，
 * schema 怎么变都不用改这个文件。
 *
 * **但"哪些行属于这栋房子"是语义判断，不能从外键图自动推**（比如
 * `observation` 挂在 place 上而不是 household 上，因为环境数据属于
 * "地点+时间"不属于某个人）——所以 `TABLES` 里的 where 是手写的。
 */

export type Snapshot = {
  /** 抓的是哪栋房子（原始 id，仅供追溯，恢复时不复用） */
  sourceHouseholdId: string;
  sourceLabel: string;
  /** 抓取时刻；`asOf` 非空时只含此刻之前创建的行 */
  capturedAt: string;
  asOf: string | null;
  /**
   * 真实号码 → **槽位号**（`+15559000001` 这种）。
   *
   * 槽位号是**稳定的代号**，不是真能用来发消息的号：场景 JSON 里写它，
   * 每次恢复时再换成一个当次独有的真实测试号。
   *
   * 为什么不能直接把槽位号插进库：`person_contact` 上
   * `(kind, value)` 是**全局**唯一索引，同一份快照恢复第二次就会撞，
   * 并发跑批必炸。所以槽位号只活在文件里，落库的号每次都不一样。
   */
  phoneMap: Record<string, string>;
  /** 每张表的行，按 TABLES 的顺序存 */
  tables: Record<string, Record<string, unknown>[]>;
};

/**
 * 抓取与恢复的表清单，**顺序即恢复时的插入顺序**（外键依赖决定）。
 *
 * `where` 用 `:hh` 占位符表示 household id。
 *
 * `timeCol` 是 `--as-of` 截断用的时间列，**每张表都必须显式写**，
 * 没有默认值。原因是踩过：一开始图省事写成"有 created_at 就按它截"，
 * 结果 `message`（只有 `sent_at`）、`decision`（`decided_at`）、
 * `event`（`recorded_at`）、`conversation`（`started_at`）、
 * `outreach_run`（`started_at`）这五张表**静默不截断**——快照看着正常，
 * 实际混进了截止点之后发生的事，重放出来的"历史时刻"是假的。
 * 这类静默错误比报错危险得多，所以这里宁可啰嗦：新加表时类型系统会逼你
 * 明确回答"这张表按哪个时间算它诞生"。
 *
 * 没收进来的表：
 * - `knowledge_doc` / `knowledge_chunk`：全局判例知识库，不属于任何一栋房子，
 *   恢复时本来就在库里，重复灌反而制造重复判例。
 */
const TABLES: Array<{ name: string; where: string; timeCol: string }> = [
  // 物理世界：place ← dwelling ← room，household 挂在 dwelling 上
  {
    name: "place",
    where: `id in (
      select place_id from coliving.dwelling where id in (
        select dwelling_id from coliving.household where id = :hh)
      union
      select place_id from coliving.event where household_id = :hh and place_id is not null)`,
    timeCol: "created_at",
  },
  {
    name: "dwelling",
    where: `id in (select dwelling_id from coliving.household where id = :hh)`,
    timeCol: "created_at",
  },
  {
    name: "room",
    where: `dwelling_id in (select dwelling_id from coliving.household where id = :hh)`,
    timeCol: "created_at",
  },
  { name: "household", where: `id = :hh` , timeCol: "created_at" },
  { name: "household_epoch", where: `household_id = :hh` , timeCol: "created_at" },

  // 人：能通过任何一条路径关联到这栋房子的，都要收
  {
    name: "person",
    where: `id in (
      select person_id from coliving.membership where household_id = :hh
      union select person_id from coliving.conversation where household_id = :hh
      union select to_person_id from coliving.communication where household_id = :hh and to_person_id is not null
      union select person_id from coliving.case_party where household_id = :hh
      union select person_id from coliving.case_position where household_id = :hh
      union select person_id from coliving.case_share where household_id = :hh
      union select reported_by from coliving.event where household_id = :hh and reported_by is not null
      union select person_id from coliving.memory where household_id = :hh and person_id is not null
      union select stated_by from coliving.memory where household_id = :hh and stated_by is not null
      union select person_id from coliving.obligation where household_id = :hh and person_id is not null)`,
    timeCol: "created_at",
  },
  { name: "person_contact", where: `person_id in (SUBQ_PERSON)` , timeCol: "created_at" },
  { name: "membership", where: `household_id = :hh` , timeCol: "created_at" },

  // 事务链：case ← event ← decision，rule 要排在 obligation 前面
  { name: "case_file", where: `household_id = :hh` , timeCol: "created_at" },
  { name: "event", where: `household_id = :hh` , timeCol: "recorded_at" },
  { name: "decision", where: `household_id = :hh` , timeCol: "decided_at" },
  { name: "rule", where: `household_id = :hh` , timeCol: "created_at" },
  { name: "obligation", where: `household_id = :hh` , timeCol: "created_at" },
  { name: "outcome", where: `case_id in (select id from coliving.case_file where household_id = :hh)` , timeCol: "created_at" },
  { name: "case_party", where: `household_id = :hh` , timeCol: "created_at" },
  { name: "case_position", where: `household_id = :hh` , timeCol: "created_at" },
  { name: "case_share", where: `household_id = :hh` , timeCol: "created_at" },

  // 对话：communication 与 message 互相引用，插入时先断开再回填（见下）
  { name: "conversation", where: `household_id = :hh` , timeCol: "started_at" },
  { name: "communication", where: `household_id = :hh` , timeCol: "created_at" },
  { name: "message", where: `conversation_id in (select id from coliving.conversation where household_id = :hh)` , timeCol: "sent_at" },

  { name: "memory", where: `household_id = :hh` , timeCol: "created_at" },
  {
    name: "observation",
    where: `place_id in (
      select place_id from coliving.dwelling where id in (
        select dwelling_id from coliving.household where id = :hh))`,
    timeCol: "created_at",
  },
  { name: "outreach_run", where: `household_id = :hh` , timeCol: "started_at" },
];

/** 恢复时要先置空、全部插完再回填的列——它们构成环或自引用 */
const DEFERRED: Record<string, string[]> = {
  // communication.response_message_id → message，而 message.communication_id → communication
  communication: ["response_message_id"],
  // memory.superseded_by → memory 自引用
  memory: ["superseded_by"],
};

function db(): postgres.Sql {
  const url = process.env.POSTGRES_URL;
  if (!url) throw new Error("[snapshot] 没有 POSTGRES_URL");
  return postgres(url, { max: 2, idle_timeout: 20 });
}

async function columnsOf(sql: postgres.Sql, table: string): Promise<string[]> {
  const rows = await sql<{ column_name: string }[]>`
    select column_name from information_schema.columns
    where table_schema = 'coliving' and table_name = ${table}
    order by ordinal_position`;
  return rows.map((r) => r.column_name);
}

/**
 * geography 列走 EWKT 文本（`SRID=4326;POINT(...)`）而不是默认的 WKB hex：
 * 文本形式人能读、diff 看得懂，插回去时 geography_in 也认。
 */
function selectExpr(col: string): string {
  return col === "geog" ? `st_asewkt(${col}) as geog` : `"${col}"`;
}

/**
 * 抓快照。**只读**——可以安全地对着真实住户的房子跑。
 *
 * @param asOf 只收这个时刻之前创建的行。这是"当时的数据库状态"那个
 *   "当时"——想复现某条消息进来之前的世界，就填那条消息的时间。
 */
export async function captureSnapshot(args: {
  householdId: string;
  asOf?: Date | null;
  /** 丢掉 embedding 向量（文件小很多，代价是相似判例检索行为不完全一致） */
  dropEmbeddings?: boolean;
}): Promise<Snapshot> {
  const sql = db();
  try {
    const [hh] = await sql<{ label: string }[]>`
      select label from coliving.household where id = ${args.householdId}`;
    if (!hh) throw new Error(`找不到 household ${args.householdId}`);

    const asOf = args.asOf ?? null;
    const tables: Snapshot["tables"] = {};
    // person 的子查询在 person_contact 里要复用，先缓存下来避免重复长 SQL
    let personIds: string[] = [];

    for (const t of TABLES) {
      const cols = await columnsOf(sql, t.name);
      const projection = cols
        .filter((c) => !(args.dropEmbeddings && c === "embedding"))
        .map(selectExpr)
        .join(", ");

      let where = t.where.replaceAll(":hh", `'${args.householdId}'::uuid`);
      if (where.includes("SUBQ_PERSON")) {
        where = where.replace(
          "SUBQ_PERSON",
          personIds.length
            ? personIds.map((id) => `'${id}'::uuid`).join(",")
            : "null"
        );
      }
      // 时间截断：按每张表**显式声明**的时间列来，不猜列名。
      // 声明的列在库里不存在就直接报错——宁可炸，也不要静默不截断
      // 产出一份混了未来数据、看起来却很正常的快照。
      if (asOf) {
        if (!cols.includes(t.timeCol)) {
          throw new Error(
            `[snapshot] ${t.name} 上没有声明的时间列 ${t.timeCol}——` +
              `schema 变了，去 TABLES 里更新 timeCol`
          );
        }
        where = `(${where}) and ${t.timeCol} <= '${asOf.toISOString()}'::timestamptz`;
      }

      const rows = await sql.unsafe<Record<string, unknown>[]>(
        `select ${projection} from coliving.${t.name} where ${where}`
      );
      tables[t.name] = rows;
      if (t.name === "person") personIds = rows.map((r) => String(r.id));
    }

    // ── 手机号 → 槽位号（稳定代号，场景 JSON 里引用的就是它） ────────
    const phoneMap: Record<string, string> = {};
    let seq = 1;
    for (const row of tables.person_contact ?? []) {
      const value = String(row.value ?? "");
      if (row.kind === "sms" && value && !phoneMap[value]) {
        phoneMap[value] = `+1555${String(9000000 + seq).padStart(7, "0")}`;
        seq++;
      }
    }

    return {
      sourceHouseholdId: args.householdId,
      sourceLabel: hh.label,
      capturedAt: new Date().toISOString(),
      asOf: asOf ? asOf.toISOString() : null,
      phoneMap,
      tables,
    };
  } finally {
    await sql.end();
  }
}

/**
 * 把快照恢复成一栋**全新的测试屋**。
 *
 * 返回的 `phoneMap` 是**槽位号 → 这次能真的用来发消息的号**：
 * 场景 JSON 里写的是槽位号（稳定），实际发消息要用这里返回的号（每次不同）。
 *
 * 所有 uuid 主键重新生成、外键跟着改写，手机号每次现生成，所以同一份快照
 * 可以反复恢复、并发恢复出多栋互不干扰的屋子，跑批不用串行。
 */
export async function restoreSnapshot(snap: Snapshot): Promise<{
  householdId: string;
  /** 槽位号（场景里写的） → 实际落库的测试号（这次恢复独有） */
  phoneMap: Record<string, string>;
}> {
  if (
    !process.env.VERCEL &&
    !process.env.NEXT_RUNTIME &&
    process.env.COLIVING_LOCAL_WRITE !== "1"
  ) {
    throw new Error(
      "[snapshot] 恢复要写库，本地跑必须带 COLIVING_LOCAL_WRITE=1（见 guard.ts）"
    );
  }

  const sql = db();
  try {
    // ── 1. 收集所有主键，生成 旧uuid → 新uuid 的映射 ──────────────────
    const idMap = new Map<string, string>();
    for (const t of TABLES) {
      for (const row of snap.tables[t.name] ?? []) {
        const id = row.id;
        if (typeof id === "string") idMap.set(id, crypto.randomUUID());
      }
    }
    const remap = (v: unknown): unknown =>
      typeof v === "string" && idMap.has(v) ? idMap.get(v)! : v;

    /**
     * 这一次恢复独有的号码：槽位号 → 真正落库的号。
     * 加一段随机后缀，让同一份快照可以反复恢复、并发恢复而不撞
     * `person_contact` 上那个全局唯一索引。
     */
    const runTag = Math.floor(Math.random() * 1_000_000)
      .toString()
      .padStart(6, "0");
    const livePhone: Record<string, string> = {};
    for (const [real, slot] of Object.entries(snap.phoneMap)) {
      // 槽位号后四位保留下来，肉眼能对上是哪个人；前面换成本次运行的随机段
      livePhone[slot] = `+1555${runTag}${slot.slice(-2)}`;
      void real;
    }

    let newHouseholdId = "";

    await sql.begin(async (tx) => {
      for (const t of TABLES) {
        const rows = snap.tables[t.name] ?? [];
        if (rows.length === 0) continue;
        const deferred = DEFERRED[t.name] ?? [];

        for (const original of rows) {
          const row: Record<string, unknown> = {};
          for (const [col, value] of Object.entries(original)) {
            if (deferred.includes(col)) {
              row[col] = null; // 环形引用：先断开，全部插完再回填
              continue;
            }
            row[col] = remap(value);
          }

          // ── 三条安全改写，缺一不可 ─────────────────────────────────
          if (t.name === "household") {
            // 永远是测试屋：guard.ts 的第二道闸靠这个字段
            row.is_test = true;
            row.label = `[replay] ${String(row.label ?? "")}`;
            newHouseholdId = String(row.id);
          }
          if (t.name === "person") {
            // 不把恢复出来的测试人格挂到真实 web 账号上
            row.account_id = null;
          }
          if (t.name === "person_contact" && row.kind === "sms") {
            // 真实号码绝不落进恢复出来的屋子：唯一索引会撞，
            // 更要命的是真实用户的短信会认到这个测试人格上
            const slot = snap.phoneMap[String(row.value)];
            if (!slot) {
              throw new Error(
                `[snapshot] 号码 ${row.value} 不在 phoneMap 里，拒绝原样恢复`
              );
            }
            row.value = livePhone[slot];
          }

          const cols = Object.keys(row);
          await tx.unsafe(
            `insert into coliving.${t.name} (${cols.map((c) => `"${c}"`).join(",")})
             values (${cols.map((_, i) => `$${i + 1}`).join(",")})`,
            cols.map((c) => row[c] as never)
          );
        }
      }

      // ── 2. 回填之前置空的环形引用 ────────────────────────────────────
      for (const [table, cols] of Object.entries(DEFERRED)) {
        for (const original of snap.tables[table] ?? []) {
          for (const col of cols) {
            const target = original[col];
            if (typeof target !== "string") continue;
            await tx.unsafe(
              `update coliving.${table} set "${col}" = $1 where id = $2`,
              [remap(target) as never, remap(original.id) as never]
            );
          }
        }
      }
    });

    if (!newHouseholdId) {
      throw new Error("[snapshot] 快照里没有 household 行，恢复失败");
    }
    return { householdId: newHouseholdId, phoneMap: livePhone };
  } finally {
    await sql.end();
  }
}

/**
 * 删掉一栋**恢复出来的**测试屋，连同它名下所有数据。
 *
 * 影子跑（`lib/chat/coliving/shadow.ts`）每处理一条真实短信就恢复一栋
 * 副本，跑完必须删掉，否则真实流量会在库里堆出成千上万栋僵尸测试屋。
 *
 * **只删 `is_test = true` 的房子**，这是硬闸：这个函数是按 household_id
 * 删数据的，万一调用方传错 id（比如把真实房子的 id 传进来），
 * 后果是把真人的世界删掉——所以先验，不是测试屋直接抛错。
 *
 * 删除顺序是 `TABLES` 的**倒序**：TABLES 的正序是按外键依赖排的插入
 * 顺序，倒过来就是安全的删除顺序，不用再手写一份、也不会随 schema
 * 变化而漂移。
 *
 * **但顺序对还不够——必须先把要删的 id 全部查出来，再开始删。**
 * 第一版直接照着 `TABLES[].where` 倒序 `delete ... where <子查询>`，
 * 漏删了一大半：那些 where 是**为抓取写的**，好几条依赖别的表
 * （`person` 的作用域要查 `membership`、`room`/`dwelling` 要查
 * `household`）。倒序删的时候，被依赖的那张表往往已经删空了，
 * 子查询返回 0 行，于是那批数据静默留在库里——影子跑每处理一条真实
 * 短信就漏一栋僵尸测试屋。**先查后删**（下面的 `ids` 预取）之后，
 * 每张表删的是一份固定的 id 列表，跟删除进度无关，不会再受影响。
 */
export async function dropRestoredHousehold(householdId: string): Promise<void> {
  const sql = db();
  try {
    const [hh] = await sql<{ is_test: boolean }[]>`
      select is_test from coliving.household where id = ${householdId}`;
    if (!hh) return; // 已经没了，当成功
    if (!hh.is_test) {
      throw new Error(
        `[snapshot] 拒绝删除非测试屋 ${householdId}——这个函数只能删恢复出来的副本`
      );
    }

    // ── ① 先按抓取时的作用域，把每张表要删的主键全查出来 ──────────────
    //     这一步**在任何删除发生之前**跑完，所以子查询看到的还是完整数据
    const ids: Record<string, string[]> = {};
    let personIds: string[] = [];
    for (const t of TABLES) {
      let where = t.where.replaceAll(":hh", `'${householdId}'::uuid`);
      if (where.includes("SUBQ_PERSON")) {
        where = where.replace(
          "SUBQ_PERSON",
          personIds.length
            ? personIds.map((id) => `'${id}'::uuid`).join(",")
            : "null"
        );
      }
      const rows = await sql.unsafe<{ id: string }[]>(
        `select id from coliving.${t.name} where ${where}`
      );
      ids[t.name] = rows.map((r) => r.id);
      if (t.name === "person") personIds = ids[t.name];
    }

    // ── ② 再按外键倒序删 ─────────────────────────────────────────────
    await sql.begin(async (tx) => {
      /**
       * 先断开自引用/环形引用，否则单条 DELETE 里 PG 逐行查约束时，
       * 删到"被同批另一行引用"的那一行就会炸。跟 `restoreSnapshot`
       * 里 `DEFERRED` 处理的是同一组列，方向相反。
       */
      if (ids.memory?.length) {
        await tx.unsafe(
          `update coliving.memory set superseded_by = null where id = any($1::uuid[])`,
          [ids.memory as never]
        );
      }
      if (ids.communication?.length) {
        await tx.unsafe(
          `update coliving.communication set response_message_id = null where id = any($1::uuid[])`,
          [ids.communication as never]
        );
      }

      /**
       * **`person` / `person_contact` 不能无条件删。**
       *
       * 一个人可以同时属于多栋房子（评测语料共用号码时真实发生过），
       * 而 `ids.person` 收的是"跟这栋房子有关联"的人——里面可能有人
       * 在别的房子还有 membership。直接删会撞
       * `membership_person_id_fkey`，整个事务回滚、一栋都删不掉
       * （第一版就是这么失败的，20 栋僵尸屋没删成）。
       *
       * 正确做法：等这栋房子的 membership 删完之后，再看哪些人变成了
       * "不属于任何房子"的孤儿，只删孤儿。跨房子共享的人留着，
       * 他在别的房子里还活着。
       */
      for (const t of [...TABLES].reverse()) {
        if (t.name === "person" || t.name === "person_contact") continue;
        const list = ids[t.name];
        if (!list || list.length === 0) continue;
        await tx.unsafe(`delete from coliving.${t.name} where id = any($1::uuid[])`, [
          list as never,
        ]);
      }

      const ourPeople = ids.person ?? [];
      if (ourPeople.length > 0) {
        const orphans = await tx.unsafe<{ id: string }[]>(
          `select p.id from coliving.person p
           where p.id = any($1::uuid[])
             and not exists (
               select 1 from coliving.membership m where m.person_id = p.id
             )`,
          [ourPeople as never]
        );
        const orphanIds = orphans.map((o) => o.id);
        if (orphanIds.length > 0) {
          // 联系方式跟着人走：人还在别的房子里活着就不能动他的号码
          await tx.unsafe(
            `delete from coliving.person_contact where person_id = any($1::uuid[])`,
            [orphanIds as never]
          );
          await tx.unsafe(`delete from coliving.person where id = any($1::uuid[])`, [
            orphanIds as never,
          ]);
        }
      }
    });
  } finally {
    await sql.end();
  }
}
