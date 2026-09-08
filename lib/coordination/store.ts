/**
 * 协商状态机 —— append-only JSONL 事件日志持久化层。
 *
 * 自包含、可整体删除：只 import node 内置 `fs`/`path` 和本模块 `./types` 的 `Event`
 * 类型、`./machine` 的 `Snap`/折叠原语——不 import 项目里任何业务代码、不 import 任何
 * 第三方持久化框架。核心层（types/machine/intent）仍然零耦合——状态由 `projectState`
 * 重放事件日志派生，本文件只负责把事件以 JSONL 形式落盘/读回，以及把派生快照物化成
 * checkpoint（覆盖写）供增量续放。
 *
 * 文件格式：事件日志一行一个 JSON 事件，行尾换行（JSONL），只追加、绝不覆盖已有行；
 * checkpoint 是另存的派生物化快照（覆盖写），性质不同、不混为一谈。
 *
 * 设计借鉴（详见 README「持久化（append-only JSONL）」）：
 * - 事件溯源：不“改状态”、只追加不可变事件；当前状态 = 重放事件日志推导。
 * - sqlite 物化投影：落盘只存日志本身，状态是重放出的“物化投影”；checkpoint 是
 *   “定期物化的投影 + 已重放到的 offset”，让重放不必每次整读整解析。
 * - “最近窗口”：`readLatest` 从日志末尾取最近 N 条事件，配投影即可在有限窗口内
 *   恢复上下文。
 */

import fs from "node:fs";
import path from "node:path";
import type { Event } from "./types";
import { emptySnap, foldFrom, snapFromJson, snapToJson } from "./machine";
import type { Snap, SnapJson } from "./machine";

/**
 * 把事件**追加**写到 JSONL 文件末尾（每行一个 JSON、行尾换行），绝不覆盖已有行。
 * 目录不存在时自动创建；空数组不写（也不建目录）。
 */
export function appendEvents(filePath: string, events: readonly Event[]): void {
  if (events.length === 0) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const content = events.map((e) => JSON.stringify(e) + "\n").join("");
  fs.appendFileSync(filePath, content, "utf8");
}

/**
 * 读整个 JSONL，按行解析成 `Event[]`（供 `fold` / `projectState` 重放）。文件不存在
 * 返回 `[]`。单行解析失败**跳过该行**——一条坏行不该毁掉整次重放；此外跳过顶层
 * 非对象值（如 `null`、数字），否则重放时读属性会抛错。
 */
export function loadEvents(filePath: string): Event[] {
  const raw = readFileIfExists(filePath);
  if (raw === null) return [];
  const events: Event[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue; // 坏行：跳过，不毁掉整次重放
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
    events.push(parsed as Event);
  }
  return events;
}

/**
 * 读最后 `limit` 条事件（正序），并返回文件里事件总数。它是「最近窗口」的底层：
 * 调用方把取回的尾部事件喂给 `projectState`，就只在一个有限窗口里重放、拿到最近
 * 事实。目前先整读后从末尾取——总条数 `total` 需要全量计数；checkpoint（持久化
 * 一个「已重放到第几条」的光标，让这里免于每次整读）是下一步。
 */
export function readLatest(
  filePath: string,
  limit: number
): { events: Event[]; total: number } {
  const all = loadEvents(filePath);
  const total = all.length;
  const events = limit > 0 ? all.slice(-limit) : [];
  return { events, total };
}

/* ------------------------------------------------------------------ *
 * checkpoint：物化快照 + 已重放到的 offset（覆盖写，不是事件日志）
 * ------------------------------------------------------------------ */

/**
 * 把派生快照 + 已重放到的 offset 以 JSON **覆盖写**到 checkpoint 文件。checkpoint
 * 是派生物化快照、不是事件日志，覆盖写是允许的（事件日志仍保持 append-only）。
 * 目录不存在时自动创建。
 */
export function saveCheckpoint(filePath: string, snap: Snap, offset: number): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const payload = { snap: snapToJson(snap), offset };
  fs.writeFileSync(filePath, JSON.stringify(payload), "utf8");
}

/**
 * 读 checkpoint：文件不存在或解析失败返回 `null`（区别于其它 IO 错误，后者照抛）。
 * 解析成功后把 `snap` 还原成 `Snap`，offset 必须是 `>= 0` 的整数。
 */
export function loadCheckpoint(filePath: string): { snap: Snap; offset: number } | null {
  const raw = readFileIfExists(filePath);
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null; // 解析失败：当作没有 checkpoint，由 resume 全量重放兜底
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { snap, offset } = parsed as { snap?: unknown; offset?: unknown };
  if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0) return null;
  if (typeof snap !== "object" || snap === null) return null;
  return { snap: snapFromJson(snap as SnapJson), offset };
}

/**
 * 从事件日志恢复最新快照：先读 checkpoint（没有就 `emptySnap()` + offset 0），取
 * `slice(offset)` 的增量事件用 `foldFrom` 续放，返回最新 snap 和新的 offset
 * （= 当前事件总数）。
 *
 * **等价性保证**：`resume(...).snap` 与 `fold(loadEvents(eventsFile))` 完全等价——
 * checkpoint 只是「事件前缀的物化快照」，续放等价于从头重放。
 */
export function resume(eventsFile: string, checkpointFile: string): { snap: Snap; offset: number } {
  const ckpt = loadCheckpoint(checkpointFile);
  const base = ckpt ? ckpt.snap : emptySnap();
  const baseOffset = ckpt ? ckpt.offset : 0;
  const all = loadEvents(eventsFile);
  const incremental = baseOffset >= all.length ? [] : all.slice(baseOffset);
  const snap = foldFrom(base, incremental, baseOffset);
  return { snap, offset: all.length };
}

/** 文件存在读全文；不存在返回 null（区别于其它 IO 错误，后者照抛）。 */
function readFileIfExists(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return null;
    throw err;
  }
}
