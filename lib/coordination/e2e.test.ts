/**
 * 协商状态机端到端验证（真实 LLM 意图解析 + 确定性状态机）。
 *
 * 运行：`pnpm.cmd exec tsx lib/coordination/e2e.test.ts`
 * （会真实调用 `deepseek/deepseek-v4-flash` 做意图解析，耗一点 gateway 额度，
 * 但每条消息的解析都很短、很便宜。不连数据库、不跑 Twilio。）
 *
 * 结构：5 条真实排班分支，每条都跑两遍——
 *
 * 1. **golden**：用「理想 Intent」（手工标注的正确答案）喂状态机。这是纯确定性
 *    检查：证明「只要意图解析对，这条分支状态机就能跑到预期终态、不破不变量」。
 *    万一这里挂了，是机器/场景设计问题，不是 LLM 问题。
 * 2. **llm**：用 `llmParseIntent` 真实解析住户原话（喂的是 `projectState` 的紧凑
 *    快照 + 当前这一条消息，不是历史原文），再把 Intent 喂状态机。
 *    这一遍的结论由 LLM 的解析质量决定——解析错了、分支没跑到预期终态，如实报，
 *    不重试、不硬凑。
 *
 * 每一条消息都会打印：原话 → 理想意图 vs LLM 实际意图 → 判读
 * （exact=完全正确 / equiv=类型不同但机器等价 / wrong=解析错）。
 *
 * 退出码：golden 或 llm 的**机器断言**失败 → 1（机器/状态机类问题，必须修）；
 * 只有 llm 解析判读为 wrong 时，也按失败计（这就是要如实记录的东西）。
 */

import { config } from "dotenv";
config({ path: ".env.local" });
for (const k of ["AI_GATEWAY_API_KEY"]) {
  if (process.env[k]?.startsWith('"')) {
    process.env[k] = process.env[k]!.slice(1, -1);
  }
}

import assert from "node:assert/strict";
import { checkInvariants, projectState, reduce, step } from "./machine";
import type { StateSnapshot, StepContext, StepResult } from "./machine";
import type { Event, Intent, OutboundAction, PersonId, State } from "./types";
import { llmParseIntent } from "./llm";

/* ------------------------------------------------------------------ *
 * 场景道具
 * ------------------------------------------------------------------ */

/** 共享窗口：18:00–22:00（分钟数）。 */
const WINDOW = { start: 18 * 60, end: 22 * 60 };

const ctxOf = (participants: readonly PersonId[], sender: PersonId): StepContext => ({
  participants: [...participants],
  window: WINDOW,
  sender,
});

/** 一条要喂给机器的消息：谁说的 + 原话 + 理想解析 + 可接受的解析类型。 */
interface StepMsg {
  sender: PersonId;
  text: string;
  ideal: Intent;
  /** 语义可接受的 type 集合（机器等价或同义表达），用于宽容判读。 */
  okTypes: string[];
}

interface StepRecord {
  sender: PersonId;
  text: string;
  intent: Intent; // 这一遍实际喂给机器的 Intent
  result: StepResult;
}

interface Branch {
  name: string;
  participants: readonly PersonId[];
  msgs: StepMsg[];
  /** 跑完所有消息后期望的终态。 */
  endState: State;
  /** 期望整条分支里出现过的出站动作类型。 */
  requireActions: OutboundAction["type"][];
  /** 分支专属额外断言；返回空数组=通过，否则返回失败描述列表。 */
  customChecks: (branch: Branch, recs: StepRecord[], log: Event[]) => string[];
}

/* ------------------------------------------------------------------ *
 * 意图构造辅助
 * ------------------------------------------------------------------ */

const report = (start: number, duration: number): Intent => ({ type: "report_availability", start, duration });
const confirm = (): Intent => ({ type: "confirm" });
const counter = (start: number, duration: number): Intent => ({ type: "counter_propose", start, duration });
const askStatus = (): Intent => ({ type: "ask_status" });

/** availability 三种机器等价（都是「更新自己的可用时间」）。 */
const AVAIL = ["report_availability", "counter_propose", "add_constraint"];
const CONFIRM = ["confirm"];
const ASK = ["ask_status"];

/** 累积事件日志。 */
function push(log: Event[], r: StepResult): Event[] {
  return [...log, ...r.events];
}

/** 动作里去掉 type:"none"。 */
function realActions(actions: readonly OutboundAction[]): OutboundAction[] {
  return actions.filter((a) => a.type !== "none");
}

/* ------------------------------------------------------------------ *
 * 5 条分支
 * ------------------------------------------------------------------ */

const PART3 = ["房东", "小张", "小李"];
const PART4 = ["房东", "小张", "小李", "小赵"];

/**
 * 通用断言：终态、关键动作、不变量、不重复 propose 已确认者。
 * 返回失败描述列表。
 */
function genericChecks(branch: Branch, recs: StepRecord[], log: Event[]): string[] {
  const fails: string[] = [];
  const state = reduce(log);

  if (state !== branch.endState) {
    fails.push(`终态应为 ${branch.endState}，实际 ${state}`);
  }

  const invs = checkInvariants(log);
  if (invs.length > 0) {
    fails.push(`不变量被破坏：\n    ${invs.join("\n    ")}`);
  }

  const saw = new Set<OutboundAction["type"]>();
  for (const r of recs) for (const a of realActions(r.result.actions)) saw.add(a.type);
  for (const t of branch.requireActions) {
    if (!saw.has(t)) fails.push(`缺少关键动作 ${t}（这条分支应出现过 propose/settle/remind 之类）`);
  }

  // 不重复 propose 已确认者：模拟机器折叠语义，逐步推进「谁已确认」，
  // 在每一步出现新版 schedule_proposed 时，propose 目标不得包含当时已确认的人。
  const confirmed = new Set<PersonId>();
  for (const r of recs) {
    // 先处理本步的「打断」：reject / 改可用时间会解除该人确认。
    for (const e of r.result.events) {
      if ((e.type === "rejected" || e.type === "availability_reported") && confirmed.has(e.person)) {
        confirmed.delete(e.person);
      }
    }
    const hasNewProposal = r.result.events.some((e) => e.type === "schedule_proposed");
    if (hasNewProposal) {
      for (const a of r.result.actions) {
        if (a.type === "propose" && confirmed.has(a.person)) {
          fails.push(`重复 propose 已确认的 ${a.person}`);
        }
      }
    }
    for (const e of r.result.events) {
      if (e.type === "confirmed") confirmed.add(e.person);
    }
  }
  return fails;
}

/** S4 专属：催一下 → 只 remind 沉默者、不重发方案、催一次不重复问。 */
function silenceChecks(branch: Branch, recs: StepRecord[], log: Event[]): string[] {
  const fails: string[] = [];

  const askIdx = recs.findIndex((r) => r.intent.type === "ask_status");
  if (askIdx === -1) {
    fails.push(`没有一步 intent=ask_status（LLM 把“催一下”解析成了别的？实际各步：${recs.map((r) => r.intent.type).join("/")}）`);
    return fails;
  }
  const ask = recs[askIdx];
  const hasRePropose = ask.result.events.some((e) => e.type === "schedule_proposed");
  if (hasRePropose) fails.push("催一下不该重发新方案，却产出了 schedule_proposed");
  const actions = realActions(ask.result.actions);
  const onlyRemind = actions.length === 1 && actions[0]?.type === "remind" && actions[0].person === "小李";
  if (!onlyRemind) {
    fails.push(`催一下应只对沉默的小李 remind，实际动作：${JSON.stringify(actions)}`);
  }
  const reminded = log.filter((e) => e.type === "reminded");
  if (reminded.length !== 1 || (reminded[0] as { person: string }).person !== "小李") {
    fails.push(`reminded 应恰好一次、对象是小李，实际 ${JSON.stringify(reminded)}`);
  }
  return fails;
}

/** S3/S5 专属：已确认的人在重排后的新版方案里不应被再次 propose。 */
function noRepeatAfterFirst(branch: Branch, recs: StepRecord[], log: Event[]): string[] {
  const fails: string[] = [];
  // 找第一条 schedule_proposed 之后、谁确认过，确认后任何 propose 都不得再指向他。
  const firstProposalStep = recs.findIndex((r) => r.result.events.some((e) => e.type === "schedule_proposed"));
  if (firstProposalStep === -1) return fails;
  const confirmed = new Set<PersonId>();
  for (let i = firstProposalStep; i < recs.length; i++) {
    const r = recs[i];
    for (const e of r.result.events) {
      if (e.type === "confirmed") confirmed.add(e.person);
    }
    for (const a of r.result.actions) {
      if (a.type === "propose" && confirmed.has(a.person)) {
        fails.push(`第 ${i + 1} 步重复 propose 已确认的 ${a.person}`);
      }
    }
  }
  return fails;
}

const branches: Branch[] = [
  // 1. 全同意：三人报时间 → 排方案 → 两人确认 → 房东说“定案” → settled
  {
    name: "S1 全同意（含房东最后“定案”）",
    participants: PART3,
    msgs: [
      { sender: "房东", text: "我晚上6点半开始，用半小时", ideal: report(1110, 30), okTypes: AVAIL },
      { sender: "小张", text: "我7点开始，用一小时", ideal: report(1140, 60), okTypes: AVAIL },
      { sender: "小李", text: "我晚上6点45开始，用40分钟", ideal: report(1125, 40), okTypes: AVAIL },
      { sender: "小张", text: "没问题", ideal: confirm(), okTypes: CONFIRM },
      { sender: "小李", text: "可以", ideal: confirm(), okTypes: CONFIRM },
      { sender: "房东", text: "那就定案吧", ideal: confirm(), okTypes: CONFIRM },
    ],
    endState: "settled",
    requireActions: ["propose", "settle"],
    customChecks: () => [],
  },

  // 2. 一人拒绝原段：“不行，我必须6点就开始”→ 重排 → settled
  {
    name: "S2 一人拒绝并加硬约束（必须6点开始）",
    participants: PART3,
    msgs: [
      { sender: "房东", text: "我晚上6点半开始做，用半小时", ideal: report(1110, 30), okTypes: AVAIL },
      { sender: "小张", text: "我7点开始，用一小时", ideal: report(1140, 60), okTypes: AVAIL },
      { sender: "小李", text: "我8点才有空，用半小时", ideal: report(1200, 30), okTypes: AVAIL },
      { sender: "小李", text: "不行，我必须6点就开始，用半小时", ideal: counter(1080, 30), okTypes: AVAIL },
      { sender: "房东", text: "可以", ideal: confirm(), okTypes: CONFIRM },
      { sender: "小张", text: "可以", ideal: confirm(), okTypes: CONFIRM },
      { sender: "小李", text: "行，那就这样吧", ideal: confirm(), okTypes: CONFIRM },
    ],
    endState: "settled",
    requireActions: ["propose", "settle"],
    customChecks: noRepeatAfterFirst,
  },

  // 3. 反提：“换到7点半开始”→ 重排 → settled
  {
    name: "S3 反提（换到7点半）",
    participants: PART3,
    msgs: [
      { sender: "房东", text: "我晚上6点半开始做，用半小时", ideal: report(1110, 30), okTypes: AVAIL },
      { sender: "小张", text: "我7点开始，用一小时", ideal: report(1140, 60), okTypes: AVAIL },
      { sender: "小李", text: "我7点半开始，用45分钟", ideal: report(1170, 45), okTypes: AVAIL },
      { sender: "房东", text: "可以", ideal: confirm(), okTypes: CONFIRM },
      // 小张 msg2 已报过时长 60；这句「换到7点半开始」没重说时长 → 沿用 60，不落回默认 30。
      { sender: "小张", text: "我想换到7点半开始", ideal: counter(1170, 60), okTypes: AVAIL },
      { sender: "小李", text: "我这边没问题", ideal: confirm(), okTypes: CONFIRM },
      { sender: "小张", text: "行，同意", ideal: confirm(), okTypes: CONFIRM },
    ],
    endState: "settled",
    requireActions: ["propose", "settle"],
    customChecks: noRepeatAfterFirst,
  },

  // 4. 沉默跟进：小李一直不回，房东“催一下”→ 只 remind、不重发方案
  {
    name: "S4 沉默跟进（催一下）",
    participants: PART3,
    msgs: [
      { sender: "房东", text: "我晚上6点半开始，用半小时", ideal: report(1110, 30), okTypes: AVAIL },
      { sender: "小张", text: "我7点开始，用一小时", ideal: report(1140, 60), okTypes: AVAIL },
      { sender: "小李", text: "我7点半开始，用45分钟", ideal: report(1170, 45), okTypes: AVAIL },
      { sender: "房东", text: "可以", ideal: confirm(), okTypes: CONFIRM },
      { sender: "小张", text: "行", ideal: confirm(), okTypes: CONFIRM },
      { sender: "房东", text: "小李一直没回，帮我催一下", ideal: askStatus(), okTypes: ASK },
    ],
    endState: "proposed",
    requireActions: ["propose", "remind"],
    customChecks: silenceChecks,
  },

  // 5. 中途硬约束：第四人“6点半才到家、得从6点半开始做一小时”→ 纳入重排 → settled
  {
    name: "S5 第四人中途硬约束",
    participants: PART4,
    msgs: [
      { sender: "房东", text: "我晚上6点半开始，用半小时", ideal: report(1110, 30), okTypes: AVAIL },
      { sender: "小张", text: "我7点开始，用一小时", ideal: report(1140, 60), okTypes: AVAIL },
      { sender: "小李", text: "我7点半开始，用45分钟", ideal: report(1170, 45), okTypes: AVAIL },
      { sender: "小赵", text: "我8点才有空，用半小时", ideal: report(1200, 30), okTypes: AVAIL },
      { sender: "房东", text: "可以", ideal: confirm(), okTypes: CONFIRM },
      { sender: "小张", text: "没问题", ideal: confirm(), okTypes: CONFIRM },
      { sender: "小李", text: "可以", ideal: confirm(), okTypes: CONFIRM },
      { sender: "小赵", text: "不行，我6点半才到家，得从6点半开始做一小时", ideal: counter(1110, 60), okTypes: AVAIL },
      { sender: "小赵", text: "可以，那就这样吧", ideal: confirm(), okTypes: CONFIRM },
    ],
    endState: "settled",
    requireActions: ["propose", "settle"],
    customChecks: noRepeatAfterFirst,
  },
];

/* ------------------------------------------------------------------ *
 * 解析判读
 * ------------------------------------------------------------------ */

type Verdict = "exact" | "equiv" | "type-wrong" | "param-wrong";

function hasParams(i: Intent): boolean {
  return i.type === "report_availability" || i.type === "counter_propose" || i.type === "add_constraint";
}

function describe(i: Intent): string {
  if (hasParams(i)) return `${i.type}(${(i as { start: number }).start},${(i as { duration: number }).duration})`;
  if (i.type === "reject") return `reject${(i as { reason?: string }).reason ? `(${((i as { reason: string }).reason)})` : ""}`;
  return i.type;
}

/** 宽容判读：type 是否在可接受集、数字是否对得上理想。 */
function classify(msg: StepMsg, actual: Intent): Verdict {
  const paramsSame =
    !hasParams(msg.ideal) ||
    !hasParams(actual) ||
    (msg.ideal as { start: number }).start === (actual as { start: number }).start &&
      (msg.ideal as { duration: number }).duration === (actual as { duration: number }).duration;

  if (hasParams(msg.ideal) && hasParams(actual) && !paramsSame) return "param-wrong";
  if (!msg.okTypes.includes(actual.type)) return "type-wrong";
  if (actual.type !== msg.ideal.type) return "equiv";
  return "exact";
}

/* ------------------------------------------------------------------ *
 * 极简 async 测试骨架
 * ------------------------------------------------------------------ */

interface TestCase {
  name: string;
  fn: () => Promise<void> | void;
}

const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void {
  tests.push({ name, fn });
}

/**
 * 跑一遍分支（喂 intent 的方式可换成理想或 LLM 解析），返回逐步记录。
 * 每一步在解析前先拿**当前已累积的 events** 投影出一份紧凑快照（含发消息的人），
 * 交给解析器；golden 分支忽略快照，LLM 分支把它传给 `llmParseIntent`。
 */
async function feedBranch(
  branch: Branch,
  resolve: (m: StepMsg, snap: StateSnapshot) => Promise<Intent> | Intent
): Promise<StepRecord[]> {
  let log: Event[] = [];
  const recs: StepRecord[] = [];
  for (const m of branch.msgs) {
    const snap = projectState(log, { participants: branch.participants, window: WINDOW, sender: m.sender });
    const intent = await resolve(m, snap);
    const result = step(log, intent, ctxOf(branch.participants, m.sender));
    recs.push({ sender: m.sender, text: m.text, intent, result });
    log = push(log, result);
  }
  return recs;
}

/** 跑 golden：喂理想 Intent，断言机器本身能到预期终态。 */
async function runGolden(branch: Branch): Promise<void> {
  const recs = await feedBranch(branch, (m) => m.ideal);
  const log = recs.reduce<Event[]>((acc, r) => [...acc, ...r.result.events], []);
  const fails = [
    ...genericChecks(branch, recs, log),
    ...branch.customChecks(branch, recs, log),
  ];
  assert.deepEqual(fails, [], fails.join("\n    "));
}

/** 跑 LLM 解析版，打印逐步解析判读，再跑同样断言。 */
async function runLlm(branch: Branch): Promise<void> {
  console.log(`\n--- ${branch.name}（LLM 解析）---`);
  const recs = await feedBranch(branch, (m, snap) => llmParseIntent(m.text, snap));
  const log = recs.reduce<Event[]>((acc, r) => [...acc, ...r.result.events], []);

  let nExact = 0;
  let nEquiv = 0;
  let nWrong = 0;
  for (let i = 0; i < branch.msgs.length; i++) {
    const m = branch.msgs[i];
    const a = recs[i].intent;
    const v = classify(m, a);
    if (v === "exact") nExact += 1;
    else if (v === "equiv") nEquiv += 1;
    else nWrong += 1;
    console.log(`  msg${i + 1} [${v.padEnd(10)}] 理想=${describe(m.ideal).padEnd(30)} 实际=${describe(a)}`);
    console.log(`       ${m.sender}：“${m.text}”`);
  }
  console.log(`  —— 解析判读：exact=${nExact} equiv(机器等价)=${nEquiv} wrong=${nWrong}；终态=${reduce(log)}`);

  const fails = [
    ...genericChecks(branch, recs, log),
    ...branch.customChecks(branch, recs, log),
  ];
  assert.deepEqual(fails, [], fails.join("\n    "));
}

/* ------------------------------------------------------------------ *
 * 注册测试
 * ------------------------------------------------------------------ */

for (const b of branches) {
  test(`${b.name}（golden，确定性机器断言）`, () => runGolden(b));
  test(`${b.name}（llm 真实解析）`, () => runLlm(b));
}

/* ------------------------------------------------------------------ *
 * 汇总输出
 * ------------------------------------------------------------------ */

let failures = 0;

async function main(): Promise<void> {
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`PASS  ${t.name}`);
    } catch (err) {
      failures += 1;
      console.log(`FAIL  ${t.name}`);
      console.log(`      ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(`\n${tests.length - failures}/${tests.length} 通过`);
  if (failures > 0) process.exitCode = 1;
}

main();
