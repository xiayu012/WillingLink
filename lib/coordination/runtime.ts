/**
 * 协商状态机 —— 完整一轮协商的运行时入口（`runCoordinationTurn`）。
 *
 * 把调用方原本要手动串的「resume → projectState → llmParseIntent → step →
 * appendEvents/saveCheckpoint」收成一个干净入口；同时让投影直接从 `resume` 给的
 * `Snap` 出（`projectStateFromSnap`），不重复 `fold` 一遍整段事件。
 *
 * 一轮的流程：
 *
 * 1. `resume(eventsFile, checkpointFile)` —— 从 JSONL + checkpoint 恢复最新派生快照
 *    （没有 checkpoint 就全量重放），顺带拿回已读到的整段事件（供 `step` 用，不再读
 *    一遍文件）。
 * 2. `projectStateFromSnap(snap, ctx)` —— 直接投影（含参与者/共享窗口/当前说话人/
 *    recentDialogue），给意图解析当「单一事实来源」。
 * 3. `resolveIntent(message, snapshot)` —— 把这句话翻译成结构化 `Intent`。默认用
 *    `llm.ts` 的 LLM 意图解析；测试/调用方可注入确定性 stub。
 * 4. `step(events, intent, stepCtx)` —— 确定性状态转移，产出要追加的新事件 + 出站动作。
 * 5. 新事件 `appendEvents` 追加写回 JSONL；`saveCheckpoint` 落最新 `Snap` + offset
 *    （= 追加后的事件总数）。
 * 6. 返回本轮追加的事件、出站动作、终态 `state` 与终态投影 `snapshot`。
 *
 * 失败语义：本文件不兜模型异常——`llmParseIntent` 自己承诺不抛（解析失败退化成
 * `other`）；注入的 stub 由注入方保证。append/checkpoint 是 IO 错误照抛，让上层知道
 * 没写进去。
 *
 * 只 import 本模块的 `store` / `machine` / `llm` / `types`，不 import 项目业务代码。
 */

import { foldFrom, projectStateFromSnap, stateFromSnap, step } from "./machine";
import type { ProjectContext, StateSnapshot, StepContext } from "./machine";
import { appendEvents, resume, saveCheckpoint } from "./store";
import { llmParseIntent } from "./llm";
import type { Event, Intent, OutboundAction, PersonId, State, TimeWindow } from "./types";

/** 一轮协商的持久化 + 运行时上下文：事件日志 / checkpoint 路径，以及参与者全员与共享窗口。 */
export interface CoordinationRunOptions {
  /** append-only JSONL 事件日志路径（不存在则从空开始）。 */
  eventsFile: string;
  /** checkpoint 物化快照路径（不存在则全量重放兜底）。 */
  checkpointFile: string;
  /** 参与这轮协商的全部成员。 */
  participants: readonly PersonId[];
  /** 共享可用窗口，任何人的时段不得超出。 */
  window: TimeWindow;
  /**
   * 最近几条对话原文（含 AI 出站），仅供 LLM 意图解析消歧用；缺省表示没提供。
   * 由调用方在每次解析前维护——本入口只是透传进投影快照，不维护它。
   */
  recentDialogue?: readonly string[];
}

/**
 * 完整跑一轮协商：给定一条住户消息 + 说话人，恢复世界状态 → 解析意图 → 走状态机 →
 * 把新事件落 JSONL、推进 checkpoint → 返回本轮追加的事件、出站动作、终态与终态投影。
 */
export async function runCoordinationTurn(
  message: string,
  sender: PersonId,
  opts: CoordinationRunOptions,
  resolveIntent: (message: string, snapshot: StateSnapshot) => Promise<Intent> = llmParseIntent
): Promise<{ events: Event[]; actions: OutboundAction[]; state: State; snapshot: StateSnapshot }> {
  // 1) 从事件日志 + checkpoint 恢复最新派生快照（`resume` 顺带返回整段事件供 step 用）。
  const { snap, events } = resume(opts.eventsFile, opts.checkpointFile);

  // projectState 与 step 的 ctx 同源：参与者全员、共享窗口、当前说话人。
  const ctx: ProjectContext = {
    participants: opts.participants,
    window: opts.window,
    sender,
    ...(opts.recentDialogue && opts.recentDialogue.length > 0
      ? { recentDialogue: opts.recentDialogue }
      : {}),
  };

  // 2) 直接投影，不重复 fold。
  const preSnapshot = projectStateFromSnap(snap, ctx);

  // 3) 意图解析（一句话 → 结构化 Intent）。
  const intent = await resolveIntent(message, preSnapshot);

  // 4) 确定性状态转移。
  const stepCtx: StepContext = { participants: opts.participants, window: opts.window, sender };
  const result = step(events, intent, stepCtx);

  // 5) 追加事件 + 推进 checkpoint。
  const newEvents = result.events;
  const nextSnap = newEvents.length > 0 ? foldFrom(snap, newEvents, events.length) : snap;
  const nextOffset = events.length + newEvents.length;
  if (newEvents.length > 0) appendEvents(opts.eventsFile, newEvents);
  saveCheckpoint(opts.checkpointFile, nextSnap, nextOffset);

  // 6) 终态 reduce 与终态投影快照（快照里 sender 是当前说话人）。
  return {
    events: newEvents,
    actions: result.actions,
    state: stateFromSnap(nextSnap),
    snapshot: projectStateFromSnap(nextSnap, ctx),
  };
}
