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
import { allocateSlots, checkInvariants, projectState, reduce, step } from "./machine";
import type { StepContext } from "./machine";
import type { Assignment, Event, PersonId, TimeSlot } from "./types";
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
