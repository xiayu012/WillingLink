/**
 * 协商状态机 —— append-only JSONL 事件日志持久化层。
 *
 * 自包含、可整体删除：只 import node 内置 `fs`/`path` 和 `./types` 的 `Event` 类型，
 * 不 import 项目里任何业务代码、不 import 任何第三方持久化框架。核心层
 * （types/machine/intent）仍然零耦合——状态由 `projectState` 重放事件日志派生，
 * 本文件只负责把事件以 JSONL 形式落盘和读回。
 *
 * 文件格式：一行一个 JSON 事件，行尾换行（JSONL）。只追加、绝不覆盖已有行。
 *
 * 设计借鉴（详见 README「持久化（append-only JSONL）」）：
 * - 事件溯源：不“改状态”、只追加不可变事件；当前状态 = 重放事件日志推导。
 * - sqlite 物化投影：落盘只存日志本身，状态是重放出的“物化投影”，不另存一份。
 * - “最近窗口”：`readLatest` 从日志末尾取最近 N 条事件，配投影即可在有限窗口内
 *   恢复上下文；checkpoint（持久化已重放到的位置/物化快照）留作后续。
 */

import fs from "node:fs";
import path from "node:path";
import type { Event } from "./types";

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

/** 文件存在读全文；不存在返回 null（区别于其它 IO 错误，后者照抛）。 */
function readFileIfExists(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return null;
    throw err;
  }
}
