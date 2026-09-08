/**
 * llm.ts 的 fastIntent 确定性快速路径纯函数单测。
 *
 * 运行：`pnpm.cmd exec tsx lib/coordination/llm.test.ts`
 *
 * 用 `node:assert`，**不调 LLM**：`llmParseIntent` 只在 `fastIntent` 返回 null 时才会
 * 真正请求模型，本文件只测 `fastIntent`，所以一条模型调用都不会发生（import ./llm 会
 * 连带加载 providers，但没有副作用）。
 *
 * 覆盖：
 * - 纯寒暄 → `{ type: "other" }`（含带尾随标点/问号的“在吗？”）；
 * - 纯确认 → `{ type: "confirm" }`（含「可以，没问题」组合）；
 * - 空串 / 只标点 → `{ type: "other" }`；
 * - 反例一律返回 null（不短路，继续走 LLM）：任何带时间/数字/否定/疑问/犹豫信号的
 *   短句都不能被正则硬判。
 */

import assert from "node:assert/strict";
import { fastIntent } from "./llm";
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
