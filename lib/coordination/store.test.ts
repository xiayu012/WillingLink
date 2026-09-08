/**
 * store.ts（append-only JSONL 事件日志持久化层）纯 IO 单测。
 *
 * 运行：`pnpm.cmd exec tsx lib/coordination/store.test.ts`
 *
 * 用 `node:fs` 临时目录 + `node:assert`，不调 LLM、不连数据库、不 import 项目业务
 * 代码（只 import 本目录模块 + node 内置 assert/fs/os/path）。
 *
 * 覆盖：
 * - append 后 load 能 roundtrip（字段、顺序、`latestStart` 可选字段都保留）；
 * - append 是追加不是覆盖：写 A、再写 B，load 得到 [A, B]；
 * - 空/不存在文件 load 返回 `[]`；
 * - `readLatest` 只返回最后 N 条、`total` 是全部条数；
 * - 手工塞一行坏 JSON，load 跳过坏行仍能解析其它行。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendEvents, loadEvents, readLatest } from "./store";
import type { Event } from "./types";

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

const WINDOW = { start: 18 * 60, end: 22 * 60 };
const SLOT_A = { start: 18 * 60, end: 18 * 60 + 30 };
const SLOT_B = { start: 19 * 60, end: 20 * 60 };

/** 每轮测试共用一个临时目录（mkdtemp），测试用不同文件名避免互相干扰。 */
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "coordination-store-"));
const tmpFile = (name: string): string => path.join(tmpDir, name);

/* ------------------------------------------------------------------ *
 * 用例
 * ------------------------------------------------------------------ */

test("append 后 load 能 roundtrip：字段、顺序、latestStart 可选字段都保留", () => {
  // 写进嵌套目录，顺便验证「目录不存在时自动建目录」。
  const f = path.join(tmpDir, "nested", "deep", "roundtrip.jsonl");
  const events: Event[] = [
    { type: "availability_reported", person: "A", start: 18 * 60, duration: 30 },
    {
      type: "availability_reported",
      person: "B",
      start: 19 * 60,
      duration: 60,
      latestStart: 19 * 60 + 30, // 可选字段：写进去要原样读回
    },
    {
      type: "schedule_proposed",
      window: WINDOW,
      assignments: [
        { person: "A", slot: SLOT_A },
        { person: "B", slot: SLOT_B },
      ],
    },
    { type: "rejected", person: "B", reason: "这个时间不太行" },
    {
      type: "settled",
      window: WINDOW,
      assignments: [{ person: "A", slot: SLOT_A }],
    },
  ];
  appendEvents(f, events);

  const loaded = loadEvents(f);
  assert.deepEqual(loaded, events); // 顺序、全部字段都在

  const first = loaded[0];
  assert.equal(first.type, "availability_reported");
  if (first.type === "availability_reported") {
    assert.equal(first.latestStart, undefined); // 没写就不出现
  }
  const second = loaded[1];
  assert.equal(second.type, "availability_reported");
  if (second.type === "availability_reported") {
    assert.equal(second.latestStart, 19 * 60 + 30); // 可选字段保留
  }
});

test("append 是追加不是覆盖：写 A、再写 B，load 得到 [A, B]", () => {
  const f = tmpFile("append.jsonl");
  const evA: Event = { type: "confirmed", person: "A" };
  const evB: Event = { type: "reminded", person: "B" };

  appendEvents(f, [evA]);
  appendEvents(f, [evB]);

  assert.deepEqual(loadEvents(f), [evA, evB]);
});

test("空/不存在文件 load 返回 []；空数组 append 不写文件", () => {
  const missing = tmpFile("no-such.jsonl");
  assert.deepEqual(loadEvents(missing), []);

  const empty = tmpFile("empty.jsonl");
  fs.writeFileSync(empty, "");
  assert.deepEqual(loadEvents(empty), []);

  // 空数组不写：文件不落地，目录也不建。
  const never = path.join(tmpDir, "never", "created", "ghost.jsonl");
  appendEvents(never, []);
  assert.equal(fs.existsSync(never), false);
});

test("readLatest 只返回最后 N 条（正序）、total 是全部条数", () => {
  const f = tmpFile("latest.jsonl");
  const events: Event[] = [
    { type: "availability_reported", person: "A", start: 0, duration: 10 },
    { type: "availability_reported", person: "B", start: 10, duration: 20 },
    { type: "confirmed", person: "A" },
    { type: "confirmed", person: "B" },
    { type: "settled", window: { start: 0, end: 60 }, assignments: [{ person: "A", slot: { start: 0, end: 10 } }] },
  ];
  appendEvents(f, events);

  const tail = readLatest(f, 3);
  assert.equal(tail.total, 5);
  assert.deepEqual(tail.events, [events[2], events[3], events[4]]); // 正序取尾

  // limit 大于总数 → 全给
  const all = readLatest(f, 999);
  assert.equal(all.total, 5);
  assert.deepEqual(all.events, events);

  // limit 0 / 负数 → 空事件、total 不变
  assert.deepEqual(readLatest(f, 0), { events: [], total: 5 });
  assert.deepEqual(readLatest(f, -1), { events: [], total: 5 });

  // 文件不存在 → total 0
  assert.deepEqual(readLatest(tmpFile("nope.jsonl"), 3), { events: [], total: 0 });
});

test("手工塞一行坏 JSON / 空行，load 跳过坏行仍能解析其它行", () => {
  const f = tmpFile("bad-line.jsonl");
  const good1: Event = { type: "confirmed", person: "A" };
  const good2: Event = { type: "confirmed", person: "B" };

  appendEvents(f, [good1]);
  fs.appendFileSync(f, "{ 这不是合法 JSON }\n", "utf8"); // 坏行：解析失败要跳过
  fs.appendFileSync(f, "\n", "utf8"); // 空行：不影响
  fs.appendFileSync(f, "null\n", "utf8"); // 能解析但不是事件对象：也要跳过
  appendEvents(f, [good2]);

  const loaded = loadEvents(f);
  assert.deepEqual(loaded, [good1, good2]);
});

test("readLatest 同样不受坏行影响：按可解析的事件取尾", () => {
  const f = tmpFile("latest-bad-line.jsonl");
  const events: Event[] = [
    { type: "confirmed", person: "A" },
    { type: "reminded", person: "B" },
    { type: "reminded", person: "C" },
  ];
  appendEvents(f, events);
  fs.appendFileSync(f, "不是 JSON\n", "utf8");
  const evD: Event = { type: "confirmed", person: "D" };
  appendEvents(f, [evD]);

  const tail = readLatest(f, 2);
  assert.equal(tail.total, 4);
  assert.deepEqual(tail.events, [
    { type: "reminded", person: "C" },
    { type: "confirmed", person: "D" },
  ]);
});

/* ------------------------------------------------------------------ *
 * 汇总输出
 * ------------------------------------------------------------------ */

let failures = 0;
try {
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
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log(`\n${tests.length - failures}/${tests.length} 通过`);
if (failures > 0) process.exitCode = 1;
