/**
 * 协商状态机纯单测。
 *
 * 运行：`pnpm.cmd exec tsx lib/coordination/machine.test.ts`
 *
 * 覆盖 README / CODEX_TASK 要求的场景：
 * - 报告可用时间 → 全员报齐后排出方案；
 * - 全员确认 → 定案；
 * - 一人拒绝/反提 → 重排（已确认的人钉死不动）；
 * - 沉默 → 只 remind、不重发方案、催一次不重复问；
 * - 不变量：重复确认不重复 propose、时段不重叠、未全员确认不 settle。
 *
 * 纯函数测试：不调 LLM、不连数据库、不 import 项目业务代码（只 import 本目录
 * 模块 + node 内置 assert）。
 */

import assert from "node:assert/strict";
import {
  allocateSlots,
  checkInvariants,
  diagnoseInfeasibility,
  emptySnap,
  fold,
  foldFrom,
  projectState,
  projectStateFromSnap,
  reduce,
  snapToJson,
  step,
} from "./machine";
import type { Snap, StepContext } from "./machine";
import type { Assignment, Event, OutboundAction, PersonId, TimeSlot } from "./types";
import { parseIntent } from "./intent";

/* ------------------------------------------------------------------ *
 * 极简测试骨架（避免引入任何框架，`tsx 文件` 直接跑）
 * ------------------------------------------------------------------ */

interface TestCase {
  name: string;
  fn: () => void;
}

const tests: TestCase[] = [];

function test(name: string, fn: () => void): void {
  tests.push({ name, fn });
}

/* ------------------------------------------------------------------ *
 * 场景道具
 * ------------------------------------------------------------------ */

/** 共享窗口：18:00–22:00（分钟数）。 */
const WINDOW = { start: 18 * 60, end: 22 * 60 };
const A: PersonId = "A";
const B: PersonId = "B";
const C: PersonId = "C";
const PARTICIPANTS = [A, B, C];

const ctxOf = (sender: PersonId): StepContext => ({
  participants: [...PARTICIPANTS],
  window: WINDOW,
  sender,
});

function slotOf(assignments: readonly Assignment[] | undefined, person: PersonId): TimeSlot | undefined {
  return assignments?.find((a) => a.person === person)?.slot;
}

/** 把 step 的新事件追加进日志。 */
function push(log: Event[], result: { events: Event[] }): Event[] {
  return [...log, ...result.events];
}

/** 角色化 Intent 构造。 */
const reportIntent = (start: number, duration: number) =>
  ({ type: "report_availability" as const, start, duration });

const confirmIntent = () => ({ type: "confirm" as const });
const askStatusIntent = () => ({ type: "ask_status" as const });
const counterIntent = (start: number, duration: number) =>
  ({ type: "counter_propose" as const, start, duration });

/** 一路报到到「全员报齐、已排出第一版方案」，返回日志。 */
function loggedProposal(): Event[] {
  let log: Event[] = [];
  log = push(log, step(log, reportIntent(18 * 60, 30), ctxOf(A)));
  log = push(log, step(log, reportIntent(19 * 60, 60), ctxOf(B)));
  log = push(log, step(log, reportIntent(18 * 60 + 30, 45), ctxOf(C)));
  return log;
}

const lastProposalAssignments = (log: Event[]): Assignment[] => {
  for (let i = log.length - 1; i >= 0; i--) {
    const e = log[i];
    if (e.type === "schedule_proposed") return e.assignments;
  }
  throw new Error("日志里没有 schedule_proposed");
};

const hasEventOfType = (log: Event[], type: Event["type"]): boolean => log.some((e) => e.type === type);

/**
 * 把 Snap 摊平排序成可比较的规范形：Map 摊成按 person 排序的记录、Set 摊成排序数组，
 * 让「成员与数值一致但内部遍历顺序可不定」的两张快照也能用 deepEqual 比等价。
 */
function canonicalSnap(s: Snap): unknown {
  const j = snapToJson(s);
  return {
    settled: j.settled,
    currentProposal: j.currentProposal,
    reported: Object.fromEntries(
      Object.entries(j.reported).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
    ),
    confirmed: [...j.confirmed].sort(),
    reminded: [...j.reminded].sort(),
    activeDisputants: [...j.activeDisputants].sort(),
    allConfirmed: j.allConfirmed,
    lastProposalIndex: j.lastProposalIndex,
    lastDisruptIndex: j.lastDisruptIndex,
  };
}

/* ------------------------------------------------------------------ *
 * reduce：空日志 / 简单派生
 * ------------------------------------------------------------------ */

test("reduce([]) === gathering", () => {
  assert.equal(reduce([]), "gathering");
});

/* ------------------------------------------------------------------ *
 * projectState：紧凑状态快照（给 LLM 的「单一事实来源」）
 * ------------------------------------------------------------------ */

const projCtx = (sender: PersonId): Parameters<typeof projectState>[1] => ({
  participants: [...PARTICIPANTS],
  window: WINDOW,
  sender,
});

test("projectState：gathering 阶段——列已报到的人、还在等谁、窗口、说话人", () => {
  let log: Event[] = [];
  log = push(log, step(log, reportIntent(18 * 60, 30), ctxOf(A)));

  const snap = projectState(log, projCtx(A));
  assert.equal(snap.state, "gathering");
  assert.equal(snap.settled, false);
  assert.equal(snap.sender, A);
  assert.deepEqual(snap.participants, [A, B, C]);
  assert.deepEqual(snap.window, WINDOW);
  assert.equal(snap.proposal, null);
  // 已报到的人只有 A；B、C 还没开口 → 在等他们
  assert.deepEqual(snap.reported, [{ person: A, start: 18 * 60, duration: 30 }]);
  assert.deepEqual(snap.confirmed, []);
  assert.deepEqual(snap.waiting, [B, C]);
  assert.deepEqual(snap.reminded, []);
});

test("projectState：recentDialogue 透传——ctx 给了就原样列出，没给就是空数组", () => {
  const log = loggedProposal();
  const snap = projectState(log, {
    ...projCtx(A),
    recentDialogue: ["AI→小五：你最早只能排到 8 点后：20:00 到 20:30", "小五：不合适。八点太晚了"],
  });
  assert.deepEqual(snap.recentDialogue, [
    "AI→小五：你最早只能排到 8 点后：20:00 到 20:30",
    "小五：不合适。八点太晚了",
  ]);
  // 没传 recentDialogue 时缺省为空数组（不破坏既有调用方）
  assert.deepEqual(projectState(log, projCtx(B)).recentDialogue, []);
});

test("projectState：proposed + 一人确认后——有方案、列出确认与还在等谁", () => {
  const log = loggedProposal();
  const log2 = push(log, step(log, confirmIntent(), ctxOf(A)));

  const snap = projectState(log2, projCtx(B));
  assert.equal(snap.state, "proposed");
  assert.ok(snap.proposal, "有当前方案");
  if (snap.proposal) {
    // 方案覆盖全员、时段不重叠、不早于各自最早能开始
    const slotOf = (p: PersonId) => snap.proposal!.assignments.find((a) => a.person === p)!.slot;
    assert.ok(slotOf(A).start >= 18 * 60);
    assert.ok(slotOf(B).start >= 19 * 60);
    assert.ok(slotOf(C).start >= 18 * 60 + 30);
    const starts = snap.proposal.assignments.map((a) => a.slot.start).sort((x, y) => x - y);
    const ends = snap.proposal.assignments.map((a) => a.slot.end).sort((x, y) => x - y);
    for (let i = 1; i < starts.length; i++) assert.ok(starts[i]! >= ends[i - 1]!, "时段不该重叠");
  }
  assert.deepEqual(snap.confirmed, [A]);
  // 发消息的人是 B；还没确认的是 B、C
  assert.equal(snap.sender, B);
  assert.deepEqual(snap.waiting, [B, C]);
});

test("projectStateFromSnap(fold(events), ctx) 与 projectState(events, ctx) 等价", () => {
  // 若干非平凡日志，覆盖 gathering / proposed / renegotiating / settled 各状态，
  // 且包含「催过但还没报」的人（兜底参与者名单不能只按 reported 键序猜）。
  const logs: Event[][] = [];

  // (1) gathering：只有 A 报了可用时间
  let log: Event[] = [];
  log = push(log, step(log, reportIntent(18 * 60, 30), ctxOf(A)));
  logs.push(log);

  // (2) gathering + 全员报齐前被 ask_status 催过的人（B、C 收到 reminded、还没全报到）
  log = [];
  log = push(log, step(log, reportIntent(18 * 60, 30), ctxOf(A)));
  log = push(log, step(log, askStatusIntent(), ctxOf(A))); // 催还没报的 B、C
  log = push(log, step(log, reportIntent(19 * 60, 60), ctxOf(B))); // B 之后才报
  logs.push(log);

  // (3) proposed + 一人确认 → 反提重排 → 定案（settled；lastProposal/lastDisrupt 非 -1）
  log = loggedProposal();
  log = push(log, step(log, confirmIntent(), ctxOf(A)));
  log = push(log, step(log, counterIntent(19 * 60 + 30, 60), ctxOf(B)));
  log = push(log, step(log, confirmIntent(), ctxOf(C)));
  log = push(log, step(log, confirmIntent(), ctxOf(B)));
  logs.push(log);

  // (4) renegotiating：A 已确认，B 只拒绝不改约束 → 停在重排
  log = loggedProposal();
  log = push(log, step(log, confirmIntent(), ctxOf(A)));
  log = push(log, step(log, { type: "reject", reason: "这个时间不太行" }, ctxOf(B)));
  logs.push(log);

  // ctx 变体：显式参与者 / 兜底参与者 / 带 recentDialogue / 全缺省
  const ctxs: Parameters<typeof projectState>[1][] = [
    { participants: [...PARTICIPANTS], window: WINDOW, sender: A },
    { window: WINDOW, sender: A },
    { participants: [...PARTICIPANTS], window: WINDOW, sender: B, recentDialogue: ["AI→B：你最早 20:00 起。", "B：不合适。太晚了"] },
    {},
  ];

  for (let i = 0; i < logs.length; i++) {
    for (const ctx of ctxs) {
      assert.deepEqual(
        projectStateFromSnap(fold(logs[i]!), ctx),
        projectState(logs[i]!, ctx),
        `log#${i} ctx=${JSON.stringify(ctx)} 两条入口投影应等价`
      );
    }
  }
});

/* ------------------------------------------------------------------ *
 * 报告 → 排方案
 * ------------------------------------------------------------------ */

test("报到不齐时不排方案，全员报齐后排出不重叠的第一版", () => {
  let log: Event[] = [];

  const rA = step(log, reportIntent(18 * 60, 30), ctxOf(A));
  assert.deepEqual(rA.events, [{ type: "availability_reported", person: A, start: 18 * 60, duration: 30 }]);
  assert.deepEqual(rA.actions, [{ type: "none" }]);
  assert.equal(reduce(push(log, rA)), "gathering");
  log = push(log, rA);

  const rB = step(log, reportIntent(19 * 60, 60), ctxOf(B));
  assert.equal(hasEventOfType(push(log, rB), "schedule_proposed"), false);
  log = push(log, rB);

  const rC = step(log, reportIntent(18 * 60 + 30, 45), ctxOf(C));
  assert.equal(hasEventOfType(rC.events, "schedule_proposed"), true);
  assert.equal(rC.actions.length, 3);
  assert.ok(rC.actions.every((a) => a.type === "propose"));
  log = push(log, rC);

  assert.equal(reduce(log), "proposed");
  assert.deepEqual(checkInvariants(log), []);

  // 方案覆盖全员、不重叠、且各自不早于自己的最早开始
  const assignments = lastProposalAssignments(log);
  for (const p of PARTICIPANTS) {
    const slot = slotOf(assignments, p);
    assert.ok(slot, `${p} 应该有方案`);
  }
  assert.ok(slotOf(assignments, A)!.start >= 18 * 60);
  assert.ok(slotOf(assignments, B)!.start >= 19 * 60);
  assert.ok(slotOf(assignments, C)!.start >= 18 * 60 + 30);
});

/* ------------------------------------------------------------------ *
 * 全员确认 → 定案
 * ------------------------------------------------------------------ */

test("全员确认才定案：差一个确认就不出 settled", () => {
  let log = loggedProposal();

  const rA = step(log, confirmIntent(), ctxOf(A));
  assert.equal(hasEventOfType(rA.events, "settled"), false);
  log = push(log, rA);
  assert.equal(reduce(log), "proposed");

  const rB = step(log, confirmIntent(), ctxOf(B));
  assert.equal(hasEventOfType(rB.events, "settled"), false);
  log = push(log, rB);

  const rC = step(log, confirmIntent(), ctxOf(C));
  assert.equal(hasEventOfType(rC.events, "settled"), true);
  assert.deepEqual(rC.actions, lastProposalAssignments(log).map((a) => ({ type: "settle", person: a.person, slot: a.slot })));
  log = push(log, rC);

  assert.equal(reduce(log), "settled");
  assert.deepEqual(checkInvariants(log), []);

  const settled = log[log.length - 1];
  assert.equal(settled.type, "settled");
  if (settled.type === "settled") {
    // 定案的时段就是最后那版方案
    assert.deepEqual(
      settled.assignments.map((a) => ({ person: a.person, slot: a.slot })),
      lastProposalAssignments(log).map((a) => ({ person: a.person, slot: a.slot }))
    );
  }
});

/* ------------------------------------------------------------------ *
 * 一人拒绝/反提 → 重排，已确认的段不被静默改动
 * ------------------------------------------------------------------ */

test("反提触发重排：已确认的人钉死不动、不重复 propose，全部就位后定案", () => {
  let log = loggedProposal();
  const v1 = lastProposalAssignments(log);

  // A 先确认第一版
  log = push(log, step(log, confirmIntent(), ctxOf(A)));
  const aSlotV1 = slotOf(v1, A)!;

  // B 反提：最早 19:30 起、用 60 分钟
  const rB = step(log, counterIntent(19 * 60 + 30, 60), ctxOf(B));
  assert.equal(hasEventOfType(rB.events, "schedule_proposed"), true);
  // 事件里先记 B 的新可用时间，再出第二版方案
  assert.deepEqual(rB.events[0], { type: "availability_reported", person: B, start: 19 * 60 + 30, duration: 60 });

  const v2Event = rB.events.find((e): e is Extract<Event, { type: "schedule_proposed" }> => e.type === "schedule_proposed");
  assert.ok(v2Event, "重排应产出第二版方案");
  const v2 = v2Event.assignments;

  // 不变量 2：A 已确认的时段原样保留，且重排不向 A 重复 propose
  assert.deepEqual(slotOf(v2, A), aSlotV1);
  assert.ok(rB.actions.every((a) => a.type === "propose"));
  assert.ok(!rB.actions.some((a) => a.type === "propose" && a.person === A), "已确认的 A 不该被再次 propose");
  // B 的时段必须尊重新的最早开始
  assert.ok(slotOf(v2, B)!.start >= 19 * 60 + 30);
  log = push(log, rB);
  assert.equal(reduce(log), "proposed");
  assert.deepEqual(checkInvariants(log), []);

  // 只让 C 和 B 确认新版即可定案——A 的确认按「时段未变」承袭
  log = push(log, step(log, confirmIntent(), ctxOf(C)));
  assert.equal(reduce(log), "proposed");
  log = push(log, step(log, confirmIntent(), ctxOf(B)));
  assert.equal(reduce(log), "settled");
  assert.deepEqual(checkInvariants(log), []);
});

/* ------------------------------------------------------------------ *
 * 沉默 → 只 remind、不重发方案、催一次不重复问
 * ------------------------------------------------------------------ */

test("拒绝但没给出任何新约束、结果没变化时：不重发一模一样的新方案", () => {
  let log = loggedProposal();
  log = push(log, step(log, confirmIntent(), ctxOf(A))); // A 已确认

  // B 只拒绝、不改约束 → 重排结果跟现版一模一样，机器不该再 propose 一遍
  const r = step(log, { type: "reject", reason: "这个时间不太行" }, ctxOf(B));
  assert.equal(hasEventOfType(r.events, "schedule_proposed"), false);
  assert.deepEqual(r.events, [{ type: "rejected", person: B, reason: "这个时间不太行" }]);
  assert.deepEqual(r.actions, [{ type: "none" }]);
  const log2 = push(log, r);
  assert.equal(reduce(log2), "renegotiating"); // 停在重排，等人给出新约束
});

test("ask_status 只催 pending，不重发方案；催过一次不重复催", () => {
  const log = loggedProposal(); // 全员 pending
  assert.equal(log.filter((e) => e.type === "reminded").length, 0);

  const r1 = step(log, askStatusIntent(), ctxOf(A));
  assert.equal(hasEventOfType(r1.events, "schedule_proposed"), false);
  assert.equal(r1.events.length, 3);
  assert.ok(r1.events.every((e) => e.type === "reminded"));
  assert.deepEqual(r1.actions, [
    { type: "remind", person: A },
    { type: "remind", person: B },
    { type: "remind", person: C },
  ]);

  const log2 = push(log, r1);
  const r2 = step(log2, askStatusIntent(), ctxOf(A));
  assert.deepEqual(r2.events, []);
  assert.deepEqual(r2.actions, [{ type: "none" }]); // 都催过了，不再重复问
});

/* ------------------------------------------------------------------ *
 * 不变量：重复确认去重、不重叠、未全员确认不 settle
 * ------------------------------------------------------------------ */

test("重复确认被去重：不再追加事件、不重复 propose、不出 settled", () => {
  let log = loggedProposal();

  const r1 = step(log, confirmIntent(), ctxOf(A));
  assert.equal(r1.events.length, 1);
  log = push(log, r1);

  const r2 = step(log, confirmIntent(), ctxOf(A));
  assert.deepEqual(r2.events, []);
  assert.deepEqual(r2.actions, [{ type: "none" }]);
  assert.equal(reduce(log), "proposed"); // A 确认两次仍是 proposed，不会因此 settle
});

test("非参与者说话被忽略", () => {
  const log = loggedProposal();
  const outsider = { participants: [...PARTICIPANTS], window: WINDOW, sender: "陌生人" };
  assert.deepEqual(step(log, confirmIntent(), outsider), { events: [], actions: [{ type: "none" }] });
});

test("已确认的人原样重申可用时间不触发重排、不解除确认", () => {
  let log = loggedProposal();
  log = push(log, step(log, confirmIntent(), ctxOf(A))); // A 已确认第一版

  const r = step(log, reportIntent(18 * 60, 30), ctxOf(A)); // A 把原话又说了一遍
  assert.deepEqual(r.events, []);
  assert.deepEqual(r.actions, [{ type: "none" }]);
  assert.equal(reduce(log), "proposed"); // 方案没被推翻，A 仍是 proposed 里的已确认者
  assert.equal(hasEventOfType(r.events, "schedule_proposed"), false);
});

test("checkInvariants 能抓出『没全员确认就 settled』的坏日志", () => {
  const log = loggedProposal();
  const prop = log[log.length - 1];
  if (prop.type !== "schedule_proposed") throw new Error("预期最后一件事是 schedule_proposed");

  const bad: Event[] = [
    ...log,
    { type: "confirmed", person: A },
    { type: "confirmed", person: B },
    { type: "settled", window: prop.window, assignments: prop.assignments }, // C 没确认
  ];
  const violations = checkInvariants(bad);
  assert.ok(violations.some((v) => v.includes("C") && v.includes("还没有确认")), `应有 C 未确认的违规，实际：${violations}`);
});

/* ------------------------------------------------------------------ *
 * allocateSlots：确定性、不重叠、锚点保留、排不出返回 null
 * ------------------------------------------------------------------ */

test("allocateSlots 产出不重叠、不超出窗口的确定性结果", () => {
  const win = { start: 0, end: 24 * 60 };
  const a1 = allocateSlots(win, [
    { person: A, earliestStart: 0, durationMinutes: 30 },
    { person: B, earliestStart: 0, durationMinutes: 30 },
  ]);
  const a2 = allocateSlots(win, [
    { person: A, earliestStart: 0, durationMinutes: 30 },
    { person: B, earliestStart: 0, durationMinutes: 30 },
  ]);
  assert.deepEqual(a1, a2, "同样的输入必须给出同样的输出");
  assert.ok(a1);
  assert.equal(a1.length, 2);
  for (const asg of a1) {
    assert.ok(asg.slot.start >= win.start && asg.slot.end <= win.end);
  }
  const [x, y] = a1;
  assert.ok(x.slot.end <= y.slot.start || y.slot.end <= x.slot.start, "两段不该重叠");
});

test("allocateSlots 硬装不下时返回 null", () => {
  const win = { start: 0, end: 50 }; // 总共才 50 分钟
  const plan = allocateSlots(win, [
    { person: A, earliestStart: 0, durationMinutes: 30 },
    { person: B, earliestStart: 0, durationMinutes: 30 },
  ]);
  assert.equal(plan, null);
});

test("allocateSlots 尊重已钉死的锚点", () => {
  const win = { start: 18 * 60, end: 22 * 60 };
  const plan = allocateSlots(
    win,
    [{ person: B, earliestStart: 18 * 60, durationMinutes: 60 }],
    [{ person: A, slot: { start: 18 * 60, end: 18 * 60 + 30 } }] // A 已确认，钉死
  );
  assert.ok(plan);
  assert.deepEqual(slotOf(plan, A), { start: 18 * 60, end: 18 * 60 + 30 });
  const bSlot = slotOf(plan, B)!;
  assert.ok(bSlot.start >= 18 * 60 + 30, "B 必须排在 A 之后");
});

/* ------------------------------------------------------------------ *
 * allocateSlots：latestStart（最晚必须开始）上限约束
 * ------------------------------------------------------------------ */

test("allocateSlots 尊重 latestStart：带最晚上限的人不会被排到上限之后", () => {
  // 窗口 0–90。A 必须 30 分钟起步、不得晚于 30 开始；B 要用满 60 分钟。
  // 唯一可行排法是把 A 放在 0–30（start=0 ≤ 30），B 再填 30–90。
  const win = { start: 0, end: 90 };
  const plan = allocateSlots(win, [
    { person: A, earliestStart: 0, durationMinutes: 30, latestStart: 30 },
    { person: B, earliestStart: 0, durationMinutes: 60 },
  ]);
  assert.ok(plan, "应能找到同时满足两人约束的排法");
  assert.equal(plan.length, 2);
  const aSlot = slotOf(plan, A)!;
  const bSlot = slotOf(plan, B)!;
  assert.ok(aSlot.start <= 30, `A 不得晚于 30 开始，实际 start=${aSlot.start}`);
  assert.equal(aSlot.start, 0, "A 只能落在 0–30");
  assert.ok(aSlot.end <= bSlot.start || bSlot.end <= aSlot.start, "两段不该重叠");
  assert.ok(bSlot.start >= aSlot.end, "B 必须排在 A 之后");
});

test("allocateSlots 尊重 latestStart：上限让原本可排的场景变成排不出 → null", () => {
  // 窗口 0–120。B 已确认、钉死在 0–90，A 只能塞 90–120 的空当；但 A 带着
  // latestStart=30（不得晚于 30 开始），放进去就违约 → 必须返回 null。
  const win = { start: 0, end: 120 };
  const planWithLatest = allocateSlots(
    win,
    [{ person: A, earliestStart: 0, durationMinutes: 30, latestStart: 30 }],
    [{ person: B, slot: { start: 0, end: 90 } }]
  );
  assert.equal(planWithLatest, null);
  // 对照组：同样的场景去掉 latestStart 就排得出来，证明是这个上限导致排不出。
  const planNoLatest = allocateSlots(
    win,
    [{ person: A, earliestStart: 0, durationMinutes: 30 }],
    [{ person: B, slot: { start: 0, end: 90 } }]
  );
  assert.ok(planNoLatest, "去掉 latestStart 后应能排进 90–120 的空当");
  assert.deepEqual(slotOf(planNoLatest!, A), { start: 90, end: 120 });
});

/* ------------------------------------------------------------------ *
 * step 排不出 → blocked 诊断（不再静默失败）
 * ------------------------------------------------------------------ */

test("全员报齐但总时长超窗口：step 返回 blocked（duration_over_window），住户报到事件不丢", () => {
  const W = { start: 0, end: 90 }; // 窗口只有 90 分钟
  const two: readonly PersonId[] = [A, B];
  const ctx = (sender: PersonId): StepContext => ({ participants: [...two], window: W, sender });

  let log: Event[] = [];
  // A：60 分钟。单独看放得下（0–60 ≤ 90），还没到全员报齐，不排方案。
  const rA = step(log, reportIntent(0, 60), ctx(A));
  assert.equal(hasEventOfType(rA.events, "schedule_proposed"), false);
  assert.deepEqual(rA.actions, [{ type: "none" }]);
  log = push(log, rA);

  // B 也报 60 分钟 → 合计 120 > 90，allocateSlots 排不出 → blocked，而不是静默 none。
  const rB = step(log, reportIntent(0, 60), ctx(B));
  assert.equal(hasEventOfType(rB.events, "schedule_proposed"), false);
  assert.equal(hasEventOfType(rB.events, "availability_reported"), true, "住户已报的事实不能因排不出而丢");
  const blocked = rB.actions.find((a): a is Extract<OutboundAction, { type: "blocked" }> => a.type === "blocked");
  assert.ok(blocked, `应返回 blocked，实际 ${JSON.stringify(rB.actions)}`);
  assert.ok(
    blocked.reasons.some((r) => r.kind === "duration_over_window" && r.message.length > 0),
    `diagnose 应命中 duration_over_window 且 message 非空，实际 ${JSON.stringify(blocked.reasons)}`
  );
  // 没硬排出一版 → 状态仍留在 gathering；但不沉默——调用方拿得到诊断。
  assert.equal(reduce(push(log, rB)), "gathering");

  // diagnoseInfeasibility 直接调用也应命中同一原因。
  const diag = diagnoseInfeasibility(W, [
    { person: A, earliestStart: 0, durationMinutes: 60 },
    { person: B, earliestStart: 0, durationMinutes: 60 },
  ]);
  assert.ok(
    diag.some((r) => r.kind === "duration_over_window" && r.message.length > 0),
    `直接诊断应命中 duration_over_window，实际 ${JSON.stringify(diag)}`
  );
});

test("某人最晚开始早于最早开始（自相矛盾）：step 排不出 → blocked 命中 latest_before_earliest", () => {
  const W = { start: 0, end: 100 };
  const two: readonly PersonId[] = [A, B];
  const ctx = (sender: PersonId): StepContext => ({ participants: [...two], window: W, sender });

  let log: Event[] = [];
  // A：最早 30 开始、用 30 分钟，却给最晚开始 20 → [20,30] 为空，自相矛盾。
  const rA = step(log, { type: "report_availability", start: 30, duration: 30, latestStart: 20 }, ctx(A));
  assert.deepEqual(rA.actions, [{ type: "none" }]);
  log = push(log, rA);

  // B 报齐 → allocateSlots 因 A 的 latestStart < earliestStart 排不出 → blocked。
  const rB = step(log, reportIntent(0, 30), ctx(B));
  assert.equal(hasEventOfType(rB.events, "schedule_proposed"), false);
  const blocked = rB.actions.find((a): a is Extract<OutboundAction, { type: "blocked" }> => a.type === "blocked");
  assert.ok(blocked, `应返回 blocked，实际 ${JSON.stringify(rB.actions)}`);
  assert.ok(
    blocked.reasons.some((r) => r.kind === "latest_before_earliest" && r.person === A && r.message.length > 0),
    `diagnose 应命中 latest_before_earliest(A)，实际 ${JSON.stringify(blocked.reasons)}`
  );

  // diagnoseInfeasibility 直接调用也要命中同一 kind。
  const diag = diagnoseInfeasibility(W, [
    { person: A, earliestStart: 30, durationMinutes: 30, latestStart: 20 },
    { person: B, earliestStart: 0, durationMinutes: 30 },
  ]);
  assert.ok(
    diag.some((r) => r.kind === "latest_before_earliest" && r.person === A),
    `直接诊断应命中 latest_before_earliest(A)，实际 ${JSON.stringify(diag)}`
  );
});

test("锚点切碎的空当放不下剩余人（前三类都不足以解释）：diagnose 回退 no_fit_given_anchors", () => {
  const W = { start: 0, end: 100 };
  // 锚点占住 20–30 / 60–70，窗口剩 0–20、30–60、70–100；A 必须 0 点开始、用 30 分钟，
  // 0–30 会被 20–30 的锚点挡住 → 排布失败，但总时长没超、也非某人最早太晚/自相矛盾。
  const diag = diagnoseInfeasibility(
    W,
    [{ person: A, earliestStart: 0, durationMinutes: 30, latestStart: 0 }],
    [
      { person: B, slot: { start: 20, end: 30 } },
      { person: C, slot: { start: 60, end: 70 } },
    ]
  );
  assert.ok(
    diag.some((r) => r.kind === "no_fit_given_anchors" && r.message.length > 0),
    `应回退 no_fit_given_anchors 且 message 非空，实际 ${JSON.stringify(diag)}`
  );
});

/* ------------------------------------------------------------------ *
 * parseIntent：确定性 stub 的几条主映射
 * ------------------------------------------------------------------ */

test("parseIntent 主映射：确认 / 拒绝 / 反提 / 报到 / 问进度", () => {
  assert.deepEqual(parseIntent("我可以"), { type: "confirm" });
  assert.deepEqual(parseIntent("行"), { type: "confirm" });
  assert.deepEqual(parseIntent("不行"), { type: "reject" });
  assert.deepEqual(parseIntent("不要了"), { type: "reject" });
  assert.deepEqual(parseIntent("换到8点吧"), { type: "counter_propose", start: 8 * 60, duration: 30 });
  assert.deepEqual(parseIntent("我7点开始用30分钟"), { type: "report_availability", start: 7 * 60, duration: 30 });
  assert.deepEqual(parseIntent("晚上7点用45分钟"), { type: "report_availability", start: 19 * 60, duration: 45 });
  assert.deepEqual(parseIntent("你们排好了吗"), { type: "ask_status" });
  assert.deepEqual(parseIntent("在吗"), { type: "other" });
});

/* ------------------------------------------------------------------ *
 * fold / foldFrom / checkpoint 物化：增量续放与整段重放等价
 * ------------------------------------------------------------------ */

test("emptySnap 就是没有任何事件的初始快照", () => {
  assert.deepEqual(canonicalSnap(emptySnap()), canonicalSnap(fold([])));
});

test("foldFrom(base, 后半段, 前半长度) 与 fold(整段) 等价，且不原地改 base", () => {
  // 一段有确认、反提重排、再确认、催人的日志，让快照非平凡（currentProposal /
  // confirmed / reminded / lastProposalIndex / lastDisruptIndex 都有内容）。
  let log: Event[] = loggedProposal(); // 全员报齐 → 第一版方案
  log = push(log, step(log, confirmIntent(), ctxOf(A))); // A 确认第一版
  log = push(log, step(log, counterIntent(19 * 60 + 30, 60), ctxOf(B))); // B 反提 → 第二版方案
  log = push(log, step(log, confirmIntent(), ctxOf(C))); // C 确认新版
  log = push(log, step(log, askStatusIntent(), ctxOf(B))); // 催还没确认的 B
  const whole = fold(log);

  // 在每个可能的分割点都验证：先 fold 前半得到 base，再 foldFrom 续放后半，结果
  // 必须与 fold(整段) 等价。快照里 lastProposalIndex/lastDisruptIndex 记的是绝对
  // 下标，续放时下标要看成 baseIndex + 局部下标，这里每个分割点都试一遍能抓住
  // 下标算错导致的 renegotiating 误判。
  for (let split = 0; split <= log.length; split++) {
    const base = fold(log.slice(0, split));
    const resumed = foldFrom(base, log.slice(split), split);
    assert.deepEqual(
      canonicalSnap(resumed),
      canonicalSnap(whole),
      `分割点 ${split} 处从快照续放应与整段重放等价`
    );
  }

  // foldFrom 不原地改 base：拿一个「A 已确认第一版」的 base，续放会把 A 的确认
  // 解除的事件，base 本身应该原封不动。
  const k = log.findIndex((e) => e.type === "schedule_proposed") + 2; // 第一个方案 + A 的 confirmed
  const base = fold(log.slice(0, k));
  const before = canonicalSnap(base);
  const resumed = foldFrom(base, log.slice(k), k);
  assert.notDeepEqual(canonicalSnap(resumed), before, "续放出的新快照应不同于 base");
  assert.deepEqual(canonicalSnap(base), before, "foldFrom 不应原地改动传入的 base");
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
