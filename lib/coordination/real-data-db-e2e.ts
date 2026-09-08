/**
 * 一次性诊断（数据库只读版）：把老孙这套房子的**真实消息流水**（含 AI 出站原文）
 * 按时间顺序喂给协商状态机，看它对真实、乱糟糟的数据怎么走。
 * 运行：pnpm.cmd exec tsx lib/coordination/real-data-db-e2e.ts
 *
 * 只回放某一个 case（话题）：设环境变量 REPLAY_CASE_ID=<case_id>（支持唯一前缀），
 * 默认空 = 回放全部（保持向后兼容）。case 标签只读、只在本脚本内存里派生，不改库：
 * 出站消息用自己 `communication.case_id`；入站消息没有 communication_id，归到
 * 同一 conversation 内、时间上最近一条出站消息所属的 case。
 *
 * 与 `real-data-e2e.ts`（硬编码入站）的区别：
 * - 数据源改成**数据库只读查询**（household `bb3556fa-…` 的成员与全部消息），
 *   不 import 带 `server-only` 的 repo.ts，直连 `POSTGRES_URL`（max: 1、只读）。
 * - 每处理一条入站消息前，把**最近几条真实对话（含 AI 出站原文）**作为
 *   `recentDialogue` 喂进投影，让 LLM 能分辨「这句话在回什么」——例如小五的
 *   「不合适。八点太晚了」，只有看到 AI 刚跟她说过「你最早只能排到 8 点后：
 *   20:00 到 20:30」，才知道她拒的是那档，而不是凭空报了个「八点有空」。
 *
 * 安全：全程只读（只 SELECT），不写库、不发短信、不 import server-only 代码。
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import postgres from "postgres";
import { projectState, reduce, step } from "./machine";
import { llmParseIntent } from "./llm";
import type { Event, Intent, OutboundAction, TimeWindow } from "./types";

const HOUSEHOLD_ID = "bb3556fa-5599-43fe-9c84-563d0e0470cd";

/** 共享可用窗口：17:30–21:00（覆盖真实排班里老孙的 17:30 档）。 */
const WINDOW: TimeWindow = { start: 17 * 60 + 30, end: 21 * 60 };

/** recentDialogue 最多保留最近多少条真实消息。 */
const RECENT_LIMIT = 6;

/** 写进 recentDialogue 时单条消息先截断到多长（防止无界膨胀）。 */
const RECENT_CLIP = 200;

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

/** 按码点截断到约 max 个字，超长补 "…"。 */
function clip(text: string, max: number): string {
  const chars = Array.from(text.trim());
  if (chars.length <= max) return text.trim();
  return `${chars.slice(0, max).join("")}…`;
}

/** 分钟数 → "HH:MM"。 */
function fmtMinute(minute: number): string {
  const h = Math.floor(minute / 60);
  const m = minute % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** 诊断用：把时间戳打成一行的前缀（本地时区的月-日 时:分）。 */
function fmtTime(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 一条真实消息行 = 查询带出的原始字段 + 内存里派生的 case 标签。
 * `caseId` 对出站消息是它自己 `communication.case_id`；入站消息没有
 * communication_id，查询恒为 null，`derived` 由脚本按「同一 conversation 最近一条
 * 出站」填上。
 */
interface MsgRow {
  direction: "inbound" | "outbound";
  conversationId: string;
  body: string;
  sentAt: Date;
  name: string;
  act: string | null;
  /** 出站消息自己挂的 communication.case_id（可能为 null）；入站恒为 null。 */
  caseId: string | null;
  caseKind: string | null;
  caseTitle: string | null;
  /** 派生 case：出站 = 自己的 caseId；入站 = 同一 conversation 最近一条出站的 caseId。 */
  derived: string | null;
}

/** 诊断用：case 元数据表（caseId → kind/title，由出站消息的 case_file 带出来）。 */
type CaseMeta = ReadonlyMap<string, { kind: string; title: string }>;

/** 诊断用：把 case id 打成短标签（kind「截断的 title」；没有元数据就退回 id 前缀）。 */
function fmtCaseTag(caseId: string | null, meta: CaseMeta): string {
  if (!caseId) return "无case";
  const m = meta.get(caseId);
  if (!m || (!m.kind && !m.title)) return `${caseId.slice(0, 8)}…`;
  const title = m.title ? clip(m.title, 12) : "";
  return `${m.kind ?? "case"}${title ? `「${title}」` : ""}`;
}

/** 诊断用：把意图打成人能读的一行（availability 三类带上 start/duration/可选的 latestStart）。 */
function intentDesc(i: Intent): string {
  if (i.type === "report_availability" || i.type === "counter_propose" || i.type === "add_constraint") {
    return `${i.type}@${fmtMinute(i.start)}(${i.start})+${i.duration}min${i.latestStart !== undefined ? ` latestStart=${fmtMinute(i.latestStart)}(${i.latestStart})` : ""}`;
  }
  return i.type;
}

function actionsDesc(actions: readonly OutboundAction[]): string {
  if (actions.length === 0) return "none";
  return actions
    .map((a) => {
      if (a.type === "none") return "none";
      // blocked：不发任何内容给住户，这里只打印原因摘要，供诊断时一眼看懂为什么排不开。
      if (a.type === "blocked") {
        const summary = a.reasons
          .map((r) => `${r.kind}${r.person ? ":" + r.person : ""} ${clip(r.message, 80)}`)
          .join("；");
        return `blocked(${summary})`;
      }
      return `${a.type}:${a.person} ${"slot" in a ? `${fmtMinute(a.slot.start)}(${a.slot.start})-${fmtMinute(a.slot.end)}(${a.slot.end})` : ""}`;
    })
    .join(" | ");
}

/** 把终态快照打成人能读的几行（含 recentDialogue，证明最近对话确实进了投影）。 */
function renderSnapshotForDiag(s: {
  state: string;
  settled: boolean;
  participants: readonly string[];
  reported: ReadonlyArray<{ person: string; start: number; duration: number; latestStart?: number }>;
  proposal: {
    window: TimeWindow;
    assignments: ReadonlyArray<{ person: string; slot: { start: number; end: number } }>;
  } | null;
  confirmed: readonly string[];
  waiting: readonly string[];
  recentDialogue: readonly string[];
}): string {
  const lines = [`state=${s.state}${s.settled ? "（已定案）" : ""}`, `participants=[${s.participants.join(",")}]`];
  for (const r of s.reported) {
    const latest = r.latestStart !== undefined ? ` 最晚开始${fmtMinute(r.latestStart)}(${r.latestStart})` : "";
    lines.push(`  reported ${r.person}: 最早${fmtMinute(r.start)}(${r.start}) +${r.duration}min${latest}`);
  }
  if (s.proposal) {
    for (const a of s.proposal.assignments) {
      lines.push(`  slot ${a.person}: ${fmtMinute(a.slot.start)}(${a.slot.start})-${fmtMinute(a.slot.end)}(${a.slot.end})`);
    }
  } else {
    lines.push("  slot: (无方案)");
  }
  lines.push(`  confirmed=[${s.confirmed.join(",")}] waiting=[${s.waiting.join(",")}]`);
  if (s.recentDialogue.length > 0) {
    lines.push(`  recentDialogue(${s.recentDialogue.length}):`);
    for (const d of s.recentDialogue) lines.push(`    - ${clip(d, 160)}`);
  } else {
    lines.push("  recentDialogue: (空)");
  }
  return lines.join("\n");
}

async function main() {
  const url = process.env.POSTGRES_URL;
  if (!url) throw new Error("没有 POSTGRES_URL（检查 .env.local）");
  const sql = postgres(url, { max: 1, idle_timeout: 20 });

  try {
    // 1) 成员：此刻住在/关联这栋房子的人（valid_to is null），display_name 作 participants。
    const memberRows = await sql<{ name: string }[]>`
      select p.display_name as name
      from coliving.membership m
      join coliving.person p on p.id = m.person_id
      where m.household_id = ${HOUSEHOLD_ID} and m.valid_to is null
      order by (m.role = 'landlord') desc, p.display_name
    `;
    const participants = memberRows.map((r) => r.name);
    if (participants.length === 0) throw new Error("这栋房子没有生效成员");

    // 2) 全部消息：按 sent_at 正序。direction 区分谁说的：outbound = AI 说（name 是接收者），
    //    inbound = 住户说（name 是说话人）。把出站消息的 communication 带出来取精确 case：
    //    left join coliving.communication → case_id/act；再 left join case_file → kind/title。
    //    （入站消息没有 communication_id，com/cf 全为 null，case 由脚本内存里派生。）
    const rawMessages = await sql<{
      direction: "inbound" | "outbound";
      conversationId: string;
      body: string;
      sentAt: Date;
      name: string;
      act: string | null;
      caseId: string | null;
      caseKind: string | null;
      caseTitle: string | null;
    }[]>`
      select m.direction, m.body, m.sent_at as "sentAt", p.display_name as name,
             m.conversation_id as "conversationId", com.act,
             com.case_id as "caseId", cf.kind as "caseKind", cf.title as "caseTitle"
      from coliving.message m
      join coliving.conversation c on c.id = m.conversation_id
      join coliving.person p on p.id = m.person_id
      left join coliving.communication com on com.id = m.communication_id
      left join coliving.case_file cf on cf.id = com.case_id
      where c.household_id = ${HOUSEHOLD_ID}
      order by m.sent_at asc
    `;

    console.log(`成员(${participants.length})：${participants.join("、")}`);
    console.log(`消息共 ${rawMessages.length} 条：inbound=${rawMessages.filter((m) => m.direction === "inbound").length} outbound=${rawMessages.filter((m) => m.direction === "outbound").length}`);
    console.log(`共享窗口：${fmtMinute(WINDOW.start)}(=${WINDOW.start}) – ${fmtMinute(WINDOW.end)}(=${WINDOW.end})`);
    console.log("");

    // 3) 内存里给每条消息算派生 case 标签（只读，不改库）：按 conversation 分组、按
    //    sent_at 正序遍历——出站消息把「当前 case」更新为它自己的 caseId（可能是 null，
    //    表示这条出站没挂 case，之后的入站也跟着回落成无 case）；入站消息继承「当前
    //    case」作为它的派生 case。case 元数据（kind/title）从出站消息带出的 case_file 收。
    const caseMeta: Map<string, { kind: string; title: string }> = new Map();
    const currentCaseByConv = new Map<string, string | null>();
    let unassignedInbound = 0;
    const rows: MsgRow[] = rawMessages.map((m) => {
      const row: MsgRow = { ...m, derived: null };
      if (row.direction === "outbound") {
        row.derived = row.caseId;
        currentCaseByConv.set(row.conversationId, row.caseId);
        if (row.caseId) caseMeta.set(row.caseId, { kind: row.caseKind ?? "", title: row.caseTitle ?? "" });
      } else {
        row.derived = currentCaseByConv.get(row.conversationId) ?? null;
        if (row.derived === null) unassignedInbound += 1;
      }
      return row;
    });

    const byCase = new Map<string, number>();
    for (const r of rows) if (r.derived) byCase.set(r.derived, (byCase.get(r.derived) ?? 0) + 1);
    console.log("派生 case 分布（按消息条数，说明每个话题的切分）：");
    for (const [cid, n] of [...byCase.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${fmtCaseTag(cid, caseMeta)}  ×${n}`);
    }
    console.log(`  入站消息派生为空（前面没有出站，或最近一条出站也没挂 case；回放 case 时会被排除）：${unassignedInbound} 条`);
    console.log("");

    // 4) REPLAY_CASE_ID（默认空 = 回放全部）：只保留派生 case 匹配的消息。
    //    支持全 UUID 或唯一前缀。
    const replayTarget = (process.env.REPLAY_CASE_ID ?? "").trim();
    let replay: MsgRow[] = rows;
    if (replayTarget) {
      const ids = new Set<string>();
      for (const r of rows) if (r.derived) ids.add(r.derived);
      const exact = ids.has(replayTarget) ? replayTarget : null;
      const byPrefix = exact ? [] : [...ids].filter((id) => id.startsWith(replayTarget));
      const matched = exact ?? (byPrefix.length === 1 ? byPrefix[0] : null);
      if (!matched) {
        throw new Error(
          `REPLAY_CASE_ID=${replayTarget} 没匹配到任何派生 case（不存在、或前缀不唯一）`
        );
      }
      replay = rows.filter((r) => r.derived === matched);
      const nin = replay.filter((r) => r.direction === "inbound").length;
      console.log(
        `REPLAY_CASE_ID=${replayTarget} → 只回放 case ${matched}（${fmtCaseTag(matched, caseMeta)}）：` +
          `${replay.length} 条（inbound=${nin} outbound=${replay.length - nin}）`
      );
    } else {
      console.log("REPLAY_CASE_ID 未设置 → 回放全部消息（向后兼容）。");
    }
    console.log("");

    let events: Event[] = [];
    const recentDialogue: string[] = [];
    const pushRecent = (line: string) => {
      recentDialogue.push(line);
      while (recentDialogue.length > RECENT_LIMIT) recentDialogue.shift();
    };
    const mkLine = (direction: "inbound" | "outbound", name: string, body: string) =>
      direction === "outbound" ? `AI→${name}：${clip(body, RECENT_CLIP)}` : `${name}：${clip(body, RECENT_CLIP)}`;

    let stepped = 0;
    for (const msg of replay) {
      const body = (msg.body ?? "").trim();
      if (!body) continue;
      const tag = fmtCaseTag(msg.derived, caseMeta);

      if (msg.direction === "outbound") {
        // AI 说的：只进 recentDialogue 作上下文，不驱动状态机。打印带 case 标签，让输出
        // 能看出每段对话属于哪个话题。
        console.log(`${fmtTime(msg.sentAt)} [${tag}] outbound→${msg.name}${msg.act ? `(${msg.act})` : ""}「${clip(body, 120)}」`);
        pushRecent(mkLine("outbound", msg.name, body));
        continue;
      }

      // 住户说的：先用「当前 events + 成员 + 窗口 + 说话人 + 最近对话」投影，再解析、再走状态机。
      stepped += 1;
      const snapshot = projectState(events, {
        participants,
        window: WINDOW,
        sender: msg.name,
        recentDialogue: [...recentDialogue],
      });
      const intent = await llmParseIntent(body, snapshot);
      const before = reduce(events);
      const res = step(events, intent, { participants, window: WINDOW, sender: msg.name });
      events = [...events, ...res.events];
      const after = reduce(events);

      const mark =
        body.includes("八点太晚") || body.includes("不接受八点")
          ? "★ "
          : body.includes("我最早必须18:00开始")
            ? "● "
            : "";
      console.log(
        `${fmtTime(msg.sentAt)} ${mark}[${tag}] inbound ${msg.name}「${clip(body, 120)}」\n` +
          `        → ${intentDesc(intent)} ⇒ [${before}→${after}] ⇒ ${actionsDesc(res.actions)}`
      );
      pushRecent(mkLine("inbound", msg.name, body));
    }

    console.log(`\n入站消息共 ${stepped} 条驱动过状态机；最近对话窗口上限 ${RECENT_LIMIT} 条。`);
    console.log(`FINAL_STATE ${reduce(events)}`);
    console.log("FINAL_SNAPSHOT");
    console.log(
      renderSnapshotForDiag(
        projectState(events, { participants, window: WINDOW, recentDialogue: [...recentDialogue] })
      )
    );
  } finally {
    await sql.end();
  }
}

main().catch((e) => {
  console.error("ERR", e);
  process.exit(1);
});
