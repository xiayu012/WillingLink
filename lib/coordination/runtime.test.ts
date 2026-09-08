/**
 * runtime.ts（runCoordinationTurn 完整一轮入口）纯 Node 单测。
 *
 * 运行：`pnpm.cmd exec tsx lib/coordination/runtime.test.ts`
 *
 * 用 `node:fs` 临时目录 + `node:assert`，**不调 LLM**：每个 resolveIntent 都是注入的
 * 确定性 stub（返回固定 Intent）。import ./runtime 会连带加载 ./llm 的 providers，但和
 * llm.test.ts 一样没有副作用、不触发模型调用。
 *
 * 覆盖：
 * - 一轮结束：JSONL 追加了新事件、checkpoint 落盘、返回的 events/actions/state/snapshot
 *   正确，且下一轮（从磁盘 resume）能续放、看到上一轮写下的状态；
 * - 连续两轮报不同人的可用时间 → 续放正确；第三轮全员报齐排出方案；逐个 confirm →
 *   定案；定案后是终态，再来消息不再追加事件。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCoordinationTurn } from "./runtime";
import { fold, snapToJson } from "./machine";
import type { Snap, StateSnapshot } from "./machine";
import { loadEvents, resume } from "./store";
import type { Event, Intent, PersonId } from "./types";

/* ------------------------------------------------------------------ *
 * 极简测试骨架（避免引入任何框架，`tsx 文件` 直接跑）
 * ------------------------------------------------------------------ */

interface TestCase {
  name: string;
  fn: () => Promise<void>;
}

const tests: TestCase[] = [];

function test(name: string, fn: () => Promise<void>): void {
  tests.push({ name, fn });
}

const A: PersonId = "A";
const B: PersonId = "B";
const C: PersonId = "C";
const PARTICIPANTS = [A, B, C];
const WINDOW = { start: 18 * 60, end: 22 * 60 };

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coordination-runtime-"));
const tmpFile = (name: string): string => path.join(tmpDir, name);

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
    participantOrder: [...j.participantOrder],
  };
}

/** 跑一轮：注入一个「固定返回 intent、并记下它收到的解析前快照」的 stub 解析器。 */
async function runTurn(
  eventsFile: string,
  checkpointFile: string,
  message: string,
  sender: PersonId,
  intent: Intent
): Promise<{ result: Awaited<ReturnType<typeof runCoordinationTurn>>; preSnapshot: StateSnapshot }> {
  let preSnapshot: StateSnapshot | null = null;
  const resolveIntent = async (_m: string, snap: StateSnapshot): Promise<Intent> => {
    preSnapshot = snap;
    return intent;
  };
  const result = await runCoordinationTurn(message, sender, { eventsFile, checkpointFile, participants: [...PARTICIPANTS], window: WINDOW }, resolveIntent);
  if (!preSnapshot) throw new Error("resolveIntent 没被调用");
  return { result, preSnapshot };
}

const report = (start: number, duration: number): Intent => ({ type: "report_availability", start, duration });
const confirm = (): Intent => ({ type: "confirm" });

test("一轮：JSONL 追加、checkpoint 落盘可续放、state/actions/snapshot 正确", async () => {
  const eventsFile = tmpFile("one-round-events.jsonl");
  const ckptFile = tmpFile("one-round-ckpt.json");

  // A 报可用时间：只追加一条 availability_reported，不排方案（B、C 还没报）。
  const r1 = await runTurn(eventsFile, ckptFile, "我 18 点开始，用 30 分钟", A, report(18 * 60, 30));
  assert.deepEqual(r1.result.events, [{ type: "availability_reported", person: A, start: 18 * 60, duration: 30 }]);
  assert.deepEqual(r1.result.actions, [{ type: "none" }]);
  assert.equal(r1.result.state, "gathering");
  assert.equal(r1.result.snapshot.state, "gathering");
  assert.equal(r1.result.snapshot.sender, A);

  // 意图解析拿到的是解析前的投影（还没处理这条消息）：说话人是 A、参与者全员、还没人报到。
  assert.equal(r1.preSnapshot.sender, A);
  assert.deepEqual(r1.preSnapshot.participants, [A, B, C]);
  assert.deepEqual(r1.preSnapshot.reported, []);

  // 返回的终态快照是处理完这条消息之后的世界：A 已报到。
  assert.deepEqual(r1.result.snapshot.reported, [{ person: A, start: 18 * 60, duration: 30 }]);

  // JSONL 已追加、checkpoint 已落盘。
  const onDisk = loadEvents(eventsFile);
  assert.equal(onDisk.length, 1);
  assert.ok(fs.existsSync(ckptFile), "checkpoint 应已写入");

  // 下一轮从磁盘 resume：能看到 A 已报，B 这轮报完仍是 gathering（C 没报）。
  const r2 = await runTurn(eventsFile, ckptFile, "我 19 点开始，用 60 分钟", B, report(19 * 60, 60));
  assert.deepEqual(r2.preSnapshot.reported.map((x) => x.person), [A], "续放应看到 A 已报");
  assert.equal(r2.result.state, "gathering");
  const afterTwo = loadEvents(eventsFile);
  assert.equal(afterTwo.length, 2);

  // checkpoint 续放等价于整段重放。
  const resumed = resume(eventsFile, ckptFile);
  assert.equal(resumed.offset, 2);
  assert.deepEqual(canonicalSnap(resumed.snap), canonicalSnap(fold(afterTwo)), "resume 等价于 fold(loadEvents)");
});

test("连续报不同人的可用时间能正确续放，最终排出方案、全员确认定案；定案后是终态", async () => {
  const eventsFile = tmpFile("settle-events.jsonl");
  const ckptFile = tmpFile("settle-ckpt.json");

  // 前两轮：A、B 各自报可用时间（验证「报两个不同的人」后能续放、仍是 gathering）。
  const rA = await runTurn(eventsFile, ckptFile, "我 18 点开始用 30 分钟", A, report(18 * 60, 30));
  assert.equal(rA.result.state, "gathering");
  const rB = await runTurn(eventsFile, ckptFile, "我 19 点开始用 60 分钟", B, report(19 * 60, 60));
  assert.equal(rB.result.state, "gathering");
  assert.deepEqual(rB.preSnapshot.reported.map((x) => x.person), [A]);

  // 第三轮 C 报齐 → 排第一版方案 + 给每人发 propose。
  const rC = await runTurn(eventsFile, ckptFile, "我 18:30 开始用 45 分钟", C, report(18 * 60 + 30, 45));
  assert.equal(rC.result.state, "proposed");
  assert.ok(rC.result.events.some((e) => e.type === "schedule_proposed"), "应排出方案");
  assert.equal(rC.result.events.length, 2, "本轮 = C 的 availability_reported + schedule_proposed");
  assert.equal(rC.result.actions.length, 3);
  assert.ok(rC.result.actions.every((a) => a.type === "propose"), "第一版方案要给每人 propose");
  assert.equal(loadEvents(eventsFile).length, 4);

  // 逐个 confirm：前两个确认仍是 proposed，最后一个确认才 settled。
  const cA = await runTurn(eventsFile, ckptFile, "可以", A, confirm());
  assert.equal(cA.result.state, "proposed");
  const cB = await runTurn(eventsFile, ckptFile, "行", B, confirm());
  assert.equal(cB.result.state, "proposed");
  const cC = await runTurn(eventsFile, ckptFile, "没问题", C, confirm());
  assert.equal(cC.result.state, "settled");
  assert.ok(cC.result.events.some((e) => e.type === "settled"), "最后一人确认应追加 settled");
  assert.equal(cC.result.actions.length, 3);
  assert.ok(cC.result.actions.every((a) => a.type === "settle"), "定案要给每人发 settle");
  assert.equal(loadEvents(eventsFile).length, 8);

  // 终态 checkpoint：resume 回来是 settled、且与整段重放等价。
  const resumed = resume(eventsFile, ckptFile);
  assert.equal(resumed.offset, 8);
  assert.ok(resumed.snap.settled);
  assert.deepEqual(
    canonicalSnap(resumed.snap),
    canonicalSnap(fold(loadEvents(eventsFile))),
    "checkpoint resume 应与 fold(loadEvents) 等价"
  );

  // 定案是终态：之后的消息不再追加事件、不再出动作。
  const after = await runTurn(eventsFile, ckptFile, "随便说点什么", A, { type: "other" });
  assert.deepEqual(after.result.events, []);
  assert.deepEqual(after.result.actions, [{ type: "none" }]);
  assert.equal(after.result.state, "settled");
  assert.equal(loadEvents(eventsFile).length, 8, "终态后事件数不应再增加");
});

/* ------------------------------------------------------------------ *
 * 汇总输出
 * ------------------------------------------------------------------ */

async function main(): Promise<void> {
  let failures = 0;
  try {
    for (const t of tests) {
      try {
        await t.fn();
        console.log(`PASS  ${t.name}`);
      } catch (err) {
        failures += 1;
        console.log(`FAIL  ${t.name}`);
        console.log(`      ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      }
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log(`\n${tests.length - failures}/${tests.length} 通过`);
  if (failures > 0) process.exitCode = 1;
}

main();
