/**
 * 一次性诊断：把老孙这套房子的真实傍晚厨房对话（从数据库读的原文）喂给
 * 协商状态机，看它对真实、乱糟糟的数据怎么走。
 * 运行：pnpm.cmd exec tsx lib/coordination/real-data-e2e.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { projectState, reduce, step } from "./machine";
import { llmParseIntent } from "./llm";
import type { Event, TimeWindow } from "./types";

const WINDOW: TimeWindow = { start: 18 * 60, end: 21 * 60 }; // 18:00–21:00
const PARTICIPANTS = ["老孙", "小五", "老四"];

// 真实入站消息（傍晚厨房这段，按时间顺序；跳过了纯“你好/怎么样了”这种无信息噪音）
const REAL: Array<{ who: string; text: string }> = [
  { who: "老四", text: "六点 两个小时" },
  { who: "老孙", text: "七点。半个小时" },
  { who: "小五", text: "我6:30，然后使用半个小时" },
  { who: "老四", text: "我最早必须18:00开始，因为我的下班就是18:00到家" },
  { who: "老孙", text: "不合适" },
  { who: "老孙", text: "不行，我不能安排。" },
  { who: "老孙", text: "可以，没问题。" },
  { who: "小五", text: "六点。半个小时" },
  { who: "小五", text: "不合适。八点太晚了" },
  { who: "小五", text: "不压缩。我不接受八点" },
];

async function main() {
  let events: Event[] = [];
  for (const r of REAL) {
    // 每步先投影当前状态（含说话人），只喂「紧凑快照 + 这条消息」，不吃历史原文。
    const snapshot = projectState(events, { participants: PARTICIPANTS, window: WINDOW, sender: r.who });
    const intent = await llmParseIntent(r.text, snapshot);
    const before = reduce(events);
    const res = step(events, intent, {
      participants: PARTICIPANTS,
      window: WINDOW,
      sender: r.who,
    });
    events = [...events, ...res.events];
    const after = reduce(events);
    const acts = res.actions
      .map((a) =>
        a.type === "none"
          ? "none"
          : `${a.type}:${a.person} ${"slot" in a ? `${a.slot.start}-${a.slot.end}` : ""}`
      )
      .join(" | ");
    console.log(
      `${r.who}「${r.text}」 → ${intent.type}${"start" in intent ? `@${intent.start}+${intent.duration}` : ""} ⇒ [${before}→${after}] ⇒ ${acts}`
    );
  }
  console.log("FINAL_STATE", reduce(events));
  const finalSnap = projectState(events, { participants: PARTICIPANTS, window: WINDOW });
  console.log("FINAL_SNAPSHOT");
  console.log(renderSnapshotForDiag(finalSnap));
}

/** 诊断用：把终局快照打成人能读的几行（仅 real-data 脚本用，避免 import llm 的渲染器）。 */
function renderSnapshotForDiag(s: {
  state: string;
  participants: readonly string[];
  reported: ReadonlyArray<{ person: string; start: number; duration: number }>;
  proposal: { assignments: ReadonlyArray<{ person: string; slot: { start: number; end: number } }> } | null;
  confirmed: readonly string[];
  waiting: readonly string[];
}): string {
  const fmt = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  const lines = [`state=${s.state}`];
  for (const r of s.reported) lines.push(`  reported ${r.person}: 最早${fmt(r.start)}(${r.start}) +${r.duration}min`);
  if (s.proposal) {
    for (const a of s.proposal.assignments) {
      lines.push(`  slot ${a.person}: ${fmt(a.slot.start)}(${a.slot.start})-${fmt(a.slot.end)}(${a.slot.end})`);
    }
  } else {
    lines.push("  slot: (无方案)");
  }
  lines.push(`  confirmed=[${s.confirmed.join(",")}] waiting=[${s.waiting.join(",")}]`);
  return lines.join("\n");
}

main().catch((e) => {
  console.error("ERR", e);
  process.exit(1);
});
