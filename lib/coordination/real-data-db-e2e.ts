/**
 * 一次性诊断（数据库只读版）：把老孙这套房子的**真实消息流水**（含 AI 出站原文）
 * 按时间顺序喂给协商状态机，看它对真实、乱糟糟的数据怎么走。
 * 运行：pnpm.cmd exec tsx lib/coordination/real-data-db-e2e.ts
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
    .map((a) =>
      a.type === "none" ? "none" : `${a.type}:${a.person} ${"slot" in a ? `${fmtMinute(a.slot.start)}(${a.slot.start})-${fmtMinute(a.slot.end)}(${a.slot.end})` : ""}`
    )
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
    //    inbound = 住户说（name 是说话人）。
    const messages = await sql<{ direction: "inbound" | "outbound"; body: string; sentAt: Date; name: string }[]>`
      select m.direction, m.body, m.sent_at as "sentAt", p.display_name as name
      from coliving.message m
      join coliving.conversation c on c.id = m.conversation_id
      join coliving.person p on p.id = m.person_id
      where c.household_id = ${HOUSEHOLD_ID}
      order by m.sent_at asc
    `;

    console.log(`成员(${participants.length})：${participants.join("、")}`);
    console.log(`消息共 ${messages.length} 条：inbound=${messages.filter((m) => m.direction === "inbound").length} outbound=${messages.filter((m) => m.direction === "outbound").length}`);
    console.log(`共享窗口：${fmtMinute(WINDOW.start)}(=${WINDOW.start}) – ${fmtMinute(WINDOW.end)}(=${WINDOW.end})`);
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
    for (const msg of messages) {
      const body = (msg.body ?? "").trim();
      if (!body) continue;

      if (msg.direction === "outbound") {
        // AI 说的：只进 recentDialogue 作上下文，不驱动状态机。
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
        `${fmtTime(msg.sentAt)} ${mark}${msg.direction} ${msg.name}「${clip(body, 120)}」\n` +
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
