/**
 * llm.ts 的纯函数确定性部分单测：fastIntent 快速路径 + aiRecentlySuggestedTimeToSender
 * 上下文闸（导出只为单测）。
 *
 * 运行：`pnpm.cmd exec tsx lib/coordination/llm.test.ts`
 *
 * 用 `node:assert`，**不调 LLM**：`llmParseIntent` 只在 `fastIntent` 返回 null 时才会
 * 真正请求模型，本文件只测纯函数，所以一条模型调用都不会发生（import ./llm 会连带
 * 加载 providers，但没有副作用）。
 *
 * 覆盖：
 * - 纯寒暄 → `{ type: "other" }`（含带尾随标点/问号的“在吗？”）；
 * - 纯确认 → `{ type: "confirm" }`（含「可以，没问题」组合）；
 * - 空串 / 只标点 → `{ type: "other" }`；
 * - 反例一律返回 null（不短路，继续走 LLM）：任何带时间/数字/否定/疑问/犹豫信号的
 *   短句都不能被正则硬判；
 * - 上下文闸 `aiRecentlySuggestedTimeToSender`：「纯确认词」在「AI 刚向发消息的人征询/
 *   建议过一个具体时间」时不能短路成 confirm（要交给 LLM 消歧）——只测布尔判定，不调 LLM。
 */

import assert from "node:assert/strict";
import { aiRecentlySuggestedTimeToSender, fastIntent } from "./llm";
import type { StateSnapshot } from "./machine";
import type { Intent } from "./types";

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

const other = (): Intent => ({ type: "other" });
const confirm = (): Intent => ({ type: "confirm" });

/* ------------------------------------------------------------------ *
 * 命中：纯寒暄 → other
 * ------------------------------------------------------------------ */

test("纯寒暄命中 other：你好/您好/在吗/各时段好/谢谢/嗯", () => {
  for (const s of ["在吗", "你好", "您好", "早上好", "中午好", "晚上好", "谢谢", "多谢", "嗯"]) {
    assert.deepEqual(fastIntent(s), other(), `「${s}」应是 other`);
  }
});

test("英文寒暄命中 other：hi/hello", () => {
  assert.deepEqual(fastIntent("hi"), other());
  assert.deepEqual(fastIntent("hello"), other());
});

test("寒暄带尾部标点/空白仍命中 other", () => {
  for (const s of ["你好！", "谢谢。", " 你好 ", "您好！", "在吗？", "嗯…", "hello!"]) {
    assert.deepEqual(fastIntent(s), other(), `「${s}」剥标点后应是 other`);
  }
});

/* ------------------------------------------------------------------ *
 * 命中：纯确认 → confirm
 * ------------------------------------------------------------------ */

test("纯确认命中 confirm：可以/行/好的/好/没问题/同意/OK/是的/对/中/成交", () => {
  for (const s of ["可以", "行", "好的", "好", "没问题", "同意", "OK", "ok", "是的", "对", "中", "成交"]) {
    assert.deepEqual(fastIntent(s), confirm(), `「${s}」应是 confirm`);
  }
});

test("纯确认组合命中 confirm：可以，没问题 / 没问题，可以", () => {
  for (const s of ["可以，没问题", "没问题，可以", "可以没问题", "没问题，可以！"]) {
    assert.deepEqual(fastIntent(s), confirm(), `「${s}」应是 confirm`);
  }
});

/* ------------------------------------------------------------------ *
 * 命中：空串 / 只标点 → other
 * ------------------------------------------------------------------ */

test("空串 / 只标点命中 other", () => {
  for (const s of ["", "   ", "。。。", "！！！", "……", "？"]) {
    assert.deepEqual(fastIntent(s), other(), `「${JSON.stringify(s)}」应是 other`);
  }
});

/* ------------------------------------------------------------------ *
 * 反例：必须返回 null（含任何歧义信号都不能短路）
 * ------------------------------------------------------------------ */

test("反例返回 null：带时间/数字的短句", () => {
  for (const s of ["八点可以", "我八点有空", "我7点用30分钟", "八点太晚了", "七点可以", "换到八点"]) {
    assert.equal(fastIntent(s), null, `「${s}」应返回 null（交 LLM）`);
  }
});

test("反例返回 null：否定/拒绝", () => {
  for (const s of ["不行", "不可以", "我不同意", "不同意", "我不行", "别，不行"]) {
    assert.equal(fastIntent(s), null, `「${s}」应返回 null（交 LLM）`);
  }
});

test("反例返回 null：疑问/催办/犹豫/语气词", () => {
  for (const s of ["排好了吗", "催一下", "可以吗", "可以？", "好的？", "没问题吧", "行吧", "好的吧", "好的呢", "嗯嗯", "你好啊", "可以～", "行不行"]) {
    assert.equal(fastIntent(s), null, `「${s}」应返回 null（交 LLM）`);
  }
});

test("反例返回 null：确认词叠加额外内容（整句不只一个词）", () => {
  for (const s of ["行，同意", "行，那就这样吧", "我这边没问题", "可以，我八点有空", "没问题，7点"]) {
    assert.equal(fastIntent(s), null, `「${s}」应返回 null（交 LLM）`);
  }
});

/* ------------------------------------------------------------------ *
 * 上下文闸：aiRecentlySuggestedTimeToSender
 *
 * 纯确认词（可以/行/没问题）能走 fastIntent 短路的前提，是没有「AI 刚向发消息的人
 * 征询/建议过一个具体时间」的上下文——否则这句可能是「接受那个建议时间」（=更新自己
 * 可用时间）而不是对已排方案的 confirm，必须交 LLM 按【最近对话】消歧。这里只锁这个
 * 布尔判定本身：构造最小 StateSnapshot（sender + recentDialogue，其余字段合理空值），
 * 不调 LLM。
 * ------------------------------------------------------------------ */

/** 造一个最小 StateSnapshot：只要 sender + recentDialogue，其余字段用合理空值。 */
function gateSnap(sender: string | null, recentDialogue: readonly string[]): StateSnapshot {
  return {
    state: "proposed",
    settled: false,
    participants: sender ? [sender] : [],
    sender,
    window: null,
    reported: [],
    proposal: null,
    confirmed: [],
    waiting: [],
    reminded: [],
    recentDialogue: [...recentDialogue],
  };
}

test("闸：sender 为 null → false（不知道发给谁，无从判断）", () => {
  const s = gateSnap(null, ["AI→小五：17:30 先做，这个点方便吗？"]);
  assert.equal(aiRecentlySuggestedTimeToSender(s), false);
});

test("闸：recentDialogue 为空 / 缺省 → false", () => {
  assert.equal(aiRecentlySuggestedTimeToSender(gateSnap("小五", [])), false);
  // 缺省：字段整个没给（运行时为 undefined）也应照常返回 false，不抛错。
  const missingDialogue = {
    ...gateSnap("小五", ["AI→小五：17:30 方便吗？"]),
    recentDialogue: undefined,
  } as unknown as StateSnapshot;
  assert.equal(aiRecentlySuggestedTimeToSender(missingDialogue), false);
});

test("闸：AI 刚向 sender 征询具体时间（…17:30…方便吗）→ true", () => {
  const s = gateSnap("小五", ["AI→小五：还有个走法，17:30 先做，这个点您方便吗？"]);
  assert.equal(aiRecentlySuggestedTimeToSender(s), true);
});

test("闸：AI 刚向 sender 建议改时间（能不能改到 18:00）→ true", () => {
  const s = gateSnap("小五", ["AI→小五：你看能不能改到 18:00 开始？"]);
  assert.equal(aiRecentlySuggestedTimeToSender(s), true);
});

test("闸：AI 通知定案（排好了，你的时段是 18:00）→ false（无征询口气）", () => {
  const s = gateSnap("小五", ["AI→小五：排好了，你的时段是 18:00 到 18:30。"]);
  assert.equal(aiRecentlySuggestedTimeToSender(s), false);
});

test("闸：出站是发给别人（AI→小丽：…17:30…方便吗）→ false", () => {
  const s = gateSnap("小五", ["AI→小丽：17:30 先做，这个点方便吗？"]);
  assert.equal(aiRecentlySuggestedTimeToSender(s), false);
});

test("闸：有征询口气但没提到具体时间 → false（征询口气与时间提示需同时满足）", () => {
  const s = gateSnap("小五", ["AI→小五：你觉得这样安排方便吗？"]);
  assert.equal(aiRecentlySuggestedTimeToSender(s), false);
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
