/**
 * 纯 golden 回归：真实 kitchen_contention（老孙傍晚厨房高峰，case 47941422）在
 * 状态机下的「真实定案」复现。
 *
 * 背景：`real-data-db-e2e.ts` 用真实库流水证明这套状态机能复现真实定案
 * 「老孙 17:30–18:00、小五 18:00–18:30、老四 18:30–20:30」，但那是打印出来靠人看，
 * 不是可回归的断言。本文件把那套关键消息固化成**纯确定性 golden**：意图全部手工
 * 标注（见下方 `CASE`），不调 LLM、不连库、不 import `llm.ts`。
 *
 * 任何人改状态机（allocator 公平规则、反提/加约束的转移、重排钉死逻辑、报到的
 * 去重判定等），跑一遍本文件就能一眼看出「真实协调方案复现」有没有破。
 *
 * 运行：`pnpm.cmd exec tsx lib/coordination/real-case-regression.test.ts`
 *
 * 注意：喂的是**手工标注的 Intent**，不是 `parseIntent`/LLM 的产物——golden 的意义
 * 就是把「真实场景里这句话在机器里应该落成什么意图」也一并钉死。
 *
 * 纯函数测试：只 import 本目录模块 + node 内置 assert。
 */

import assert from "node:assert/strict";
import { checkInvariants, fold, step } from "./machine";
import type { StepContext } from "./machine";
import type { Assignment, Event, Intent, PersonId, TimeSlot, TimeWindow } from "./types";

/* ------------------------------------------------------------------ *
 * 场景道具（消息与窗口照 CODEX_TASK / real-data-db-e2e 写，别改时间）
 * ------------------------------------------------------------------ */

/** 共享窗口：17:30–21:00。 */
const WINDOW: TimeWindow = { start: 17 * 60 + 30, end: 21 * 60 };

const PARTICIPANTS: readonly PersonId[] = ["老孙", "小五", "老四"];

const ctxOf = (sender: PersonId): StepContext => ({
  participants: [...PARTICIPANTS],
  window: WINDOW,
  sender,
});

/** 手工标注的意图构造（golden：不用 parseIntent、不调 LLM）。 */
const report = (start: number, duration: number): Intent => ({ type: "report_availability", start, duration });
const addConstraint = (start: number, duration: number, latestStart?: number): Intent =>
  latestStart === undefined
    ? { type: "add_constraint", start, duration }
    : { type: "add_constraint", start, duration, latestStart };

/**
 * 真实傍晚厨房对话的关键消息（顺序敏感）+ 期望落成的 Intent。
 * 与 real-data-db-e2e.ts 里 case 47941422 的入站消息一致（剔除了纯寒暄/无信息噪音）。
 */
const CASE: ReadonlyArray<{ who: PersonId; text: string; intent: Intent }> = [
  { who: "老四", text: "六点 两个小时", intent: report(18 * 60, 120) },
  { who: "老孙", text: "七点。半个小时", intent: report(19 * 60, 30) },
  { who: "小五", text: "我6:30，然后使用半个小时", intent: report(18 * 60 + 30, 30) },
  { who: "老四", text: "我最早必须18:00开始", intent: addConstraint(18 * 60, 120) },
  { who: "老孙", text: "可以，没问题", intent: report(17 * 60 + 30, 30) },
  { who: "小五", text: "六点。半个小时", intent: report(18 * 60, 30) },
  { who: "小五", text: "不合适。八点太晚了", intent: addConstraint(18 * 60, 30, 20 * 60) },
];

/** 期望复现出的真实定案（最后一版 schedule_proposed 的档位）。 */
const EXPECTED_FINAL_SLOT: Readonly<Record<PersonId, TimeSlot>> = {
  老孙: { start: 17 * 60 + 30, end: 18 * 60 },
  小五: { start: 18 * 60, end: 18 * 60 + 30 },
  老四: { start: 18 * 60 + 30, end: 20 * 60 + 30 },
};

/* ------------------------------------------------------------------ *
 * 极简测试骨架（不引框架，`tsx 文件` 直接跑）
 * ------------------------------------------------------------------ */

interface TestCase {
  name: string;
  fn: () => void;
}

const tests: TestCase[] = [];
function test(name: string, fn: () => void): void {
  tests.push({ name, fn });
}

/** 从日志里取最后一版 schedule_proposed 的 assignments；没有就返回 null。 */
function lastProposalAssignments(log: readonly Event[]): Assignment[] | null {
  for (let i = log.length - 1; i >= 0; i--) {
    const e = log[i];
    if (e.type === "schedule_proposed") return e.assignments;
  }
  return null;
}

/** 把 step 的新事件追加进日志。 */
function push(log: Event[], result: { events: Event[] }): Event[] {
  return [...log, ...result.events];
}

/* ------------------------------------------------------------------ *
 * golden 场景
 * ------------------------------------------------------------------ */

test("真实 kitchen_contention（47941422）：逐条喂手工 Intent 复现真实定案", () => {
  // 顺序喂完整条关键消息；意图全部手工标注，零模型调用。
  let log: Event[] = [];
  for (const m of CASE) {
    log = push(log, step(log, m.intent, ctxOf(m.who)));
  }

  // —— 终态断言 1：最后一版 schedule_proposed 必须按 person 匹配真实定案 ——
  const last = lastProposalAssignments(log);
  assert.ok(last, "日志里应有一版 schedule_proposed");
  const byPerson = new Map<PersonId, TimeSlot>(last.map((a) => [a.person, a.slot]));
  for (const p of PARTICIPANTS) {
    assert.deepEqual(
      byPerson.get(p),
      EXPECTED_FINAL_SLOT[p],
      `${p} 的档位应复现真实定案 ${JSON.stringify(EXPECTED_FINAL_SLOT[p])}`
    );
  }
  assert.equal(byPerson.size, PARTICIPANTS.length, "最后一版方案应覆盖全员、一人一段");

  // —— 终态断言 2：老四 duration=120 全程不被覆盖 ——
  const snap = fold(log);
  const laosi = snap.reported.get("老四");
  assert.equal(laosi?.duration, 120, "老四全程 120 分钟（18:00–20:30）不应被改写");

  // —— 终态断言 3：小五 latestStart=1200 被记录（「八点太晚」落成最晚开始上限）——
  const xiaowu = snap.reported.get("小五");
  assert.equal(xiaowu?.latestStart, 20 * 60, "小五应带 latestStart=20:00（八点太晚→不得晚于八点开始）");

  // —— 终态断言 4：整条日志不破状态机不变量 ——
  assert.deepEqual(checkInvariants(log), []);

  // —— 附：这场真实协商到这一步还没有人确认/定案（后面还有小五「不压缩，我不接受八点」），
  //     日志里不应出现 settled/confirmed，避免 golden 静默漂成「提前定案」。 ——
  assert.ok(!log.some((e) => e.type === "settled"), "真实案例此时未定案，日志不应有 settled");
  assert.ok(!log.some((e) => e.type === "confirmed"), "真实案例此时无人确认过，日志不应有 confirmed");
});

/* ------------------------------------------------------------------ *
 * 汇总输出
 * ------------------------------------------------------------------ */

let failures = 0;
for (const t of tests) {
  try {
    t.fn();
    console.log(`PASS  ${t.name}`);
  } catch (err) {
    failures += 1;
    console.log(`FAIL  ${t.name}`);
    console.log(`      ${err instanceof Error ? err.message : String(err)}`);
  }
}

console.log(`\n${tests.length - failures}/${tests.length} 通过`);
if (failures > 0) process.exitCode = 1;
