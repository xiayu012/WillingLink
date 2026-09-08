/**
 * 协商状态机（Coordination State Machine）——确定性核心。
 *
 * 架构主张（见 README.md）：LLM 只把一句话翻成一个结构化 `Intent`；真正
 * 的「协调」由这里完成——它重放事件日志记状态、按 Intent 走转移、用代码强制
 * 不变量、决定下一步该对谁说什么。本文件不 import 项目里任何业务代码，纯函数、
 * 无副作用、不落库、不读环境变量。
 *
 * ## 事件溯源
 *
 * 不「改状态」，只**追加事件**；当前状态由 `fold` 从头重放事件日志推导。重放
 * 得到一张内部快照 `Snap`，`reduce` 和 `step` 都建立在它上面。
 *
 * ## 不变量（代码强制，不靠 LLM 自觉）
 *
 * 1. 一人同一窗口只占一段、不重叠——由 `allocateSlots` 保证产出，`checkInvariants`
 *    校验既有日志。
 * 2. 已确认的段不被静默改动——重排时把「已确认的人」钉死为锚点（时段原样保留），
 *    只有他自己发来拒绝/反提/加约束（`availability_reported`/`rejected`）才会被
 *    解除确认；新一轮 `schedule_proposed` 只在时段未变时把他承袭为已确认。
 * 3. 同一件事对同一人不重复发问——已确认的人重复 confirm 直接去重；方案 pending
 *    时 ask_status 只 `remind`、绝不重发 propose。
 * 4. `settled` 必须全员确认——最后一个 confirm 到位才追加 `settled` 事件。
 *
 * ## 时段分配（`allocateSlots`）
 *
 * 「给定共享窗口 + 每个人最早能开始/需要多久 + 若干已钉死的锚点，排成不重叠」
 * 的确定性求解：按人名字典序穷举剩余人的排列，对每种排列贪心「每个空当里最早
 * 可落位」摆放。人数很少（协商场景一般 2~6 人），穷举足够快。锚点存在时，自由
 * 的人只能塞进锚点留下的空当——已确认的锚点时段绝不会被挪动。不需要 coliving
 * 那套公平打分，简单正确即可（README 明确允许）。
 */

import type {
  Assignment,
  Event,
  Infeasibility,
  Intent,
  Minute,
  OutboundAction,
  PersonId,
  State,
  TimeSlot,
  TimeWindow,
} from "./types";

/** step 需要的运行时上下文：参与者全员、共享窗口、当前这条消息是谁发的。 */
export interface StepContext {
  /** 参与这轮协商的全部成员。排第一版方案前必须全员报过可用时间。 */
  participants: readonly PersonId[];
  /** 共享可用窗口，任何人的时段不得超出。 */
  window: TimeWindow;
  /** 正在处理这条消息的人（落到 confirmed/rejected/availability_reported 上）。 */
  sender: PersonId;
}

/** step 的产物：追加进日志的事件 + 要发出的出站动作。 */
export interface StepResult {
  events: Event[];
  actions: OutboundAction[];
}

/* ------------------------------------------------------------------ *
 * projectState：事件日志 → 紧凑状态快照（给 LLM 的「单一事实来源」）
 * ------------------------------------------------------------------ */

/** projectState 的可选运行时上下文：补齐事件日志里没有的参与全员 / 共享窗口 / 当前说话人。 */
export interface ProjectContext {
  /** 参与这轮协商的全部成员（事件日志只记开过口的人，沉默的成员要靠这里补）。 */
  participants?: readonly PersonId[];
  /** 共享可用窗口。 */
  window?: TimeWindow;
  /** 正在发当前这条消息的人（turn 上下文，跟 machine.step 的 StepContext.sender 同源）。 */
  sender?: PersonId;
  /**
   * 最近几条对话原文（含 AI 出站），**仅供 LLM 意图解析消歧用**。由调用方
   * （回放脚本等）在每次解析前维护并传入；状态机本身不依赖它做任何转移——
   * 它只是透传进 `StateSnapshot` 给 LLM 看的旁证，缺省表示调用方没提供。
   */
  recentDialogue?: readonly string[];
}

/** 某人已报的可用时间（投影里的一个人一条）。 */
export interface ProjectedAvailability {
  person: PersonId;
  start: Minute; // 最早能开始
  duration: number; // 需要占用
  latestStart?: Minute; // 最晚必须开始；缺省表示没有上限
}

/**
 * `projectState(events)` 的输出：把不可变事件日志**重放投影**成当前事实的紧凑结构。
 * 它是给 LLM 意图解析吃的「单一事实来源」——主要含状态机当前知道的事实，不倒退到
 * 把整段历史塞进 prompt 的旧做法。唯一的例外是 `recentDialogue`：那是由调用方截到
 * 最近几条、可选的对话原文（渲染层还会再截断），只用来帮 LLM 判断「这句话在回什么」。
 *
 * 注意：事件日志只记录「开过口的人」，所以沉默的参与者/共享窗口/当前说话人不在
 * 事件里，由 `ProjectContext` 补进来；缺省时参与者退化为事件里出现过的人。
 */
export interface StateSnapshot {
  /** 派生状态：gathering / proposed / settled / renegotiating。 */
  state: State;
  /** 日志里是否已出现过 settled（终态）。 */
  settled: boolean;
  /** 参与全员（顺序按 ctx.participants；缺省按事件里首次出现的顺序）。 */
  participants: PersonId[];
  /** 正在发当前这条消息的人；不知道为 null。 */
  sender: PersonId | null;
  /** 共享窗口：ctx.window，缺省取最近一版方案的窗口。 */
  window: TimeWindow | null;
  /** 每人已报的可用时间（按 participants 顺序；没报过的人不出现）。 */
  reported: ProjectedAvailability[];
  /** 当前这版方案（谁被分到哪段、待确认）；没排过就是 null。 */
  proposal: { window: TimeWindow; assignments: Assignment[] } | null;
  /** 当前方案里已确认的人。 */
  confirmed: PersonId[];
  /** 还在等谁：有方案 → 方案里还没确认的人；没方案 → 还没报到的人。 */
  waiting: PersonId[];
  /** 已被催过的人（「催一次不重复问」的去重依据）。 */
  reminded: PersonId[];
  /**
   * 最近几条对话原文（用于消歧的「这句话在回什么」），透传自 `ProjectContext.recentDialogue`。
   * 由调用方（回放脚本）维护并截到最近 N 条，渲染层每条还会再截断；状态机本身
   * 不依赖它做任何转移。缺省为 `[]`。
   */
  recentDialogue: string[];
}

/* ------------------------------------------------------------------ *
 * 内部小类型
 * ------------------------------------------------------------------ */

/** 某人「最早能开始 + 需要多久 + 最晚必须开始」的可用性约束。 */
interface Availability {
  start: Minute;
  duration: number;
  latestStart?: Minute; // 最晚必须开始；缺省表示没有上限
}

/**
 * 重放事件日志得到的派生快照。本模块内部 `reduce` / `projectState` / `step` 都建立在
 * 它上面；导出是为了让持久化层（`store.ts`）把快照物化成 checkpoint、以及从 checkpoint
 * 继续增量重放（`foldFrom`）。
 */
export interface Snap {
  /** 日志里出现过 settled（终态）。 */
  settled: boolean;
  /** 当前这版方案；没排过就是 null。 */
  currentProposal: { window: TimeWindow; assignments: Assignment[] } | null;
  /** 每个人最新的可用时间（availability_reported / 反提 / 加约束都会更新）。 */
  reported: Map<PersonId, Availability>;
  /** 当前这版方案里已确认的人（含跨版承袭）。 */
  confirmed: Set<PersonId>;
  /** 当前这版方案里已经被催过的人（「催一次不重复问」）。 */
  reminded: Set<PersonId>;
  /** 当前这版方案被 reject / 反提打断后、还没等到新版方案的人。 */
  activeDisputants: Set<PersonId>;
  /** 当前方案是否已经全员确认（仅差一个 settled 事件的情况）。 */
  allConfirmed: boolean;
  lastProposalIndex: number;
  /** 最后一次「打断」事件（rejected / 方案存在时的 availability_reported）的下标。 */
  lastDisruptIndex: number;
  /**
   * 事件里出现过的人、按**首次出现顺序**排列（去重）。由 `fold`/`foldFrom` 在重放时
   * 顺带维护——它是 `projectState` 缺省参与者名单（不传 ctx.participants 时）的兜底，
   * 等价于旧的 `participantOrderFromEvents`，只是随快照一起算好，让投影可以从 `Snap`
   * 直接出、不必再拿整段 events 重新扫一遍。
   */
  participantOrder: PersonId[];
}

function slotsEqual(a: TimeSlot, b: TimeSlot): boolean {
  return a.start === b.start && a.end === b.end;
}

function findAssignment(assignments: readonly Assignment[], person: PersonId): Assignment | undefined {
  return assignments.find((a) => a.person === person);
}

function overlaps(a: TimeSlot, b: TimeSlot): boolean {
  return a.start < b.end && b.start < a.end;
}

/* ------------------------------------------------------------------ *
 * fold / foldFrom：事件日志 → 派生快照
 * ------------------------------------------------------------------ */

/** 返回「还没有任何事件」的初始快照。 */
export function emptySnap(): Snap {
  return {
    settled: false,
    currentProposal: null,
    reported: new Map(),
    confirmed: new Set(),
    reminded: new Set(),
    activeDisputants: new Set(),
    allConfirmed: false,
    lastProposalIndex: -1,
    lastDisruptIndex: -1,
    participantOrder: [],
  };
}

/**
 * 从 `base` 快照继续处理 `events`（增量重放），返回**新**快照（Map/Set 都复制，
 * 不原地改 `base`）。`events` 里的第 i 个事件在完整日志里的下标视为
 * `baseIndex + i`——这对 `lastProposalIndex` / `lastDisruptIndex` 的取值是关键，
 * 否则增量续放会破坏 `reduce` 里 `renegotiating` 的判定。
 *
 * `fold(events)` 等价于 `foldFrom(emptySnap(), events, 0)`，本函数是真正实现。
 */
export function foldFrom(base: Snap, events: readonly Event[], baseIndex: number): Snap {
  const reported = new Map(base.reported);
  let currentProposal = base.currentProposal;
  let settled = base.settled;
  let confirmed = new Set(base.confirmed);
  let reminded = new Set(base.reminded);
  let active = new Set(base.activeDisputants);
  let lastProposalIndex = base.lastProposalIndex;
  let lastDisruptIndex = base.lastDisruptIndex;
  const participantOrder = [...base.participantOrder];
  const seenParticipants = new Set(participantOrder);
  const visitParticipant = (p: PersonId): void => {
    if (p && !seenParticipants.has(p)) {
      seenParticipants.add(p);
      participantOrder.push(p);
    }
  };

  // 用普通 for 循环而不是 forEach：`currentProposal`/`confirmed` 在循环体里会被赋值，
  // forEach 回调里看不见这些赋值，会把它错误窄化成一个 never/null，for 循环没这个问题。
  for (let i = 0; i < events.length; i++) {
    const idx = baseIndex + i; // 事件在完整日志里的绝对下标
    const e = events[i];
    switch (e.type) {
      case "availability_reported": {
        visitParticipant(e.person);
        reported.set(e.person, {
          start: e.start,
          duration: e.duration,
          ...(e.latestStart !== undefined ? { latestStart: e.latestStart } : {}),
        });
        if (currentProposal) {
          // 方案已经在等确认时又改可用时间 = 反提/加约束：解除该人确认，标记为待重排。
          confirmed.delete(e.person);
          active.add(e.person);
          lastDisruptIndex = idx;
        }
        break;
      }
      case "schedule_proposed": {
        for (const a of e.assignments) visitParticipant(a.person);
        // 新一轮方案：把「上一轮确认过、且这一轮时段没变」的人承袭为已确认。
        const prevProposal = currentProposal;
        const prevConfirmed = confirmed;
        const next = new Set<PersonId>();
        if (prevProposal) {
          for (const a of e.assignments) {
            if (!prevConfirmed.has(a.person)) continue;
            const prevSlot = findAssignment(prevProposal.assignments, a.person)?.slot;
            if (prevSlot && slotsEqual(prevSlot, a.slot)) next.add(a.person);
          }
        }
        confirmed = next;
        reminded = new Set();
        active = new Set();
        currentProposal = { window: e.window, assignments: e.assignments };
        lastProposalIndex = idx;
        break;
      }
      case "confirmed": {
        visitParticipant(e.person);
        // 只对「当前这版方案里真的有这个人」的确认计数。
        if (currentProposal && findAssignment(currentProposal.assignments, e.person)) {
          confirmed.add(e.person);
        }
        break;
      }
      case "rejected": {
        visitParticipant(e.person);
        if (currentProposal && findAssignment(currentProposal.assignments, e.person)) {
          confirmed.delete(e.person);
          active.add(e.person);
          lastDisruptIndex = idx;
        }
        break;
      }
      case "reminded": {
        visitParticipant(e.person);
        reminded.add(e.person);
        break;
      }
      case "settled": {
        for (const a of e.assignments) visitParticipant(a.person);
        settled = true;
        break;
      }
    }
  }

  const allConfirmed = currentProposal
    ? currentProposal.assignments.every((a) => confirmed.has(a.person))
    : false;

  return {
    settled,
    currentProposal,
    reported,
    confirmed,
    reminded,
    activeDisputants: active,
    allConfirmed,
    lastProposalIndex,
    lastDisruptIndex,
    participantOrder,
  };
}

/**
 * 从头重放一整段事件日志，推导派生快照。等价于
 * `foldFrom(emptySnap(), events, 0)`——保留这个名字当「从零全量重放」的惯用入口。
 */
export function fold(events: readonly Event[]): Snap {
  return foldFrom(emptySnap(), events, 0);
}

/* ------------------------------------------------------------------ *
 * Snap ⇄ SnapJson：checkpoint 物化快照的 JSON 序列化
 * ------------------------------------------------------------------ */

/**
 * `Snap` 的可 JSON 化 plain 形状（checkpoint 落盘用）。`reported` 的键是
 * `PersonId`，值是那次可用时间的紧凑对象；`confirmed` / `reminded` /
 * `activeDisputants` 是数组（Map/Set 落到 JSON 前摊平成数组）。
 */
export interface SnapJson {
  settled: boolean;
  currentProposal: { window: TimeWindow; assignments: Assignment[] } | null;
  reported: Record<PersonId, { start: Minute; duration: number; latestStart?: Minute }>;
  confirmed: PersonId[];
  reminded: PersonId[];
  activeDisputants: PersonId[];
  allConfirmed: boolean;
  lastProposalIndex: number;
  lastDisruptIndex: number;
  participantOrder: PersonId[];
}

/** 把派生快照 `Snap` 摊平成可 JSON 序列化的 `SnapJson`。 */
export function snapToJson(snap: Snap): SnapJson {
  const reported: SnapJson["reported"] = {};
  for (const [person, a] of snap.reported) {
    reported[person] =
      a.latestStart !== undefined
        ? { start: a.start, duration: a.duration, latestStart: a.latestStart }
        : { start: a.start, duration: a.duration };
  }
  return {
    settled: snap.settled,
    currentProposal: snap.currentProposal
      ? { window: snap.currentProposal.window, assignments: snap.currentProposal.assignments }
      : null,
    reported,
    confirmed: [...snap.confirmed],
    reminded: [...snap.reminded],
    activeDisputants: [...snap.activeDisputants],
    allConfirmed: snap.allConfirmed,
    lastProposalIndex: snap.lastProposalIndex,
    lastDisruptIndex: snap.lastDisruptIndex,
    participantOrder: [...snap.participantOrder],
  };
}

/**
 * 从 `SnapJson` 还原派生快照 `Snap`（roundtrip 保持等价：成员与数值一致即可）。
 *
 * `participantOrder` 是后加的投影兜底字段：读旧版本（没有该字段）的 checkpoint 时缺省
 * `[]`——那只影响「缺省参与者名单」的兜底顺序，事件日志仍可全量重放重建（等价性不受
 * 影响，`resume` 从事件续放时会把它补全）。
 */
export function snapFromJson(json: SnapJson): Snap {
  const reported = new Map<PersonId, Availability>();
  for (const person of Object.keys(json.reported)) {
    const a = json.reported[person];
    reported.set(person, {
      start: a.start,
      duration: a.duration,
      ...(a.latestStart !== undefined ? { latestStart: a.latestStart } : {}),
    });
  }
  const participantOrder = Array.isArray(json.participantOrder) ? [...json.participantOrder] : [];
  return {
    settled: json.settled,
    currentProposal: json.currentProposal
      ? { window: json.currentProposal.window, assignments: json.currentProposal.assignments }
      : null,
    reported,
    confirmed: new Set(json.confirmed),
    reminded: new Set(json.reminded),
    activeDisputants: new Set(json.activeDisputants),
    allConfirmed: json.allConfirmed,
    lastProposalIndex: json.lastProposalIndex,
    lastDisruptIndex: json.lastDisruptIndex,
    participantOrder,
  };
}

/* ------------------------------------------------------------------ *
 * projectState：事件日志 / Snap → 紧凑状态快照（给 LLM 的「单一事实来源」）
 * ------------------------------------------------------------------ */

/**
 * 从派生快照 `Snap` 直接出当前状态（`reduce` 的映射核心）。纯函数。
 *
 * 映射关系（README：状态是派生的，不落库）：
 * - 日志里出现过 `settled` → `settled`（终态）。
 * - 还没排过任何方案 → `gathering`。
 * - 最新的方案之后还有 reject / 反提等打断事件（重排没排出新方案）→ `renegotiating`。
 * - 否则有一版方案在等人确认 → `proposed`。
 */
export function stateFromSnap(s: Snap): State {
  if (s.settled) return "settled";
  if (!s.currentProposal) return "gathering";
  if (s.lastDisruptIndex > s.lastProposalIndex) return "renegotiating";
  return "proposed";
}

/**
 * 把派生快照 `Snap`（`fold` / `foldFrom` / `resume` 的结果）投影成紧凑的
 * `StateSnapshot`——不重复 `fold`。纯函数、无副作用、不 import 任何业务代码；它就是
 * 「当前状态」的单一事实来源，供 LLM 意图解析在解析每条新消息前调用：只吃这一小段
 * 事实，不吃聊天原文。
 *
 * `participants/window/sender/recentDialogue` 来自 `ctx`：事件日志只记录「开过口的人」，
 * 沉默的参与者/共享窗口/当前说话人不在事件里，由 `ctx` 补进来；缺省时参与者退化为
 * 快照里按首次出现顺序记下的人（`snap.participantOrder`），窗口退化为当前这版方案的窗口。
 */
export function projectStateFromSnap(s: Snap, ctx: ProjectContext = {}): StateSnapshot {
  const participants = ctx.participants ? [...ctx.participants] : [...s.participantOrder];
  const window = ctx.window ?? s.currentProposal?.window ?? null;

  const reported: ProjectedAvailability[] = [];
  for (const p of participants) {
    const a = s.reported.get(p);
    if (a) {
      reported.push({
        person: p,
        start: a.start,
        duration: a.duration,
        ...(a.latestStart !== undefined ? { latestStart: a.latestStart } : {}),
      });
    }
  }

  const confirmed: PersonId[] = [];
  if (s.currentProposal) {
    for (const p of participants) {
      if (s.confirmed.has(p) && findAssignment(s.currentProposal.assignments, p)) confirmed.push(p);
    }
  }

  let waiting: PersonId[];
  if (s.currentProposal) {
    waiting = participants.filter(
      (p) => !!findAssignment(s.currentProposal!.assignments, p) && !s.confirmed.has(p)
    );
  } else {
    // 还没排过方案：等还没报到的人开口。
    waiting = participants.filter((p) => !s.reported.has(p));
  }

  const reminded = participants.filter((p) => s.reminded.has(p));

  return {
    state: stateFromSnap(s),
    settled: s.settled,
    participants,
    sender: ctx.sender ?? null,
    window,
    reported,
    proposal: s.currentProposal
      ? { window: s.currentProposal.window, assignments: s.currentProposal.assignments }
      : null,
    confirmed,
    waiting,
    reminded,
    recentDialogue: ctx.recentDialogue ? [...ctx.recentDialogue] : [],
  };
}

/**
 * 把事件日志 `fold` 成派生快照再投影成紧凑的 `StateSnapshot`——薄封装：
 * `projectStateFromSnap(fold(events), ctx)`（给既有的、手里只有 events 的调用方）。
 */
export function projectState(events: readonly Event[], ctx: ProjectContext = {}): StateSnapshot {
  return projectStateFromSnap(fold(events), ctx);
}

/* ------------------------------------------------------------------ *
 * 时段分配（确定性求解）
 * ------------------------------------------------------------------ */

/** allocateSlots 的自由人输入：最早能开始 + 需要多久（+ 可选的最晚必须开始）。 */
export interface SlotConstraint {
  person: PersonId;
  earliestStart: Minute;
  durationMinutes: number;
  /** 最晚必须开始：分到的时段起点不得晚于它；缺省表示没有上限。 */
  latestStart?: Minute;
}

/** 已钉死的锚点（已确认的人，时段不允许被挪动）。 */
export interface FixedSlot {
  person: PersonId;
  slot: TimeSlot;
}

/**
 * 在窗口里给自由人排不重叠的时段。`fixed` 是已钉死的锚点时段，先占住；自由人
 * 只能塞进锚点留下的空当，各自不得早于 `earliestStart`、不得晚于自己的
 * `latestStart`（若设了）、不得超出 `window`。
 *
 * 求解方式：按人名字典序穷举自由人的全部排列，对每种排列贪心地把每个人放进「不
 * 冲突的最早空当」。因为会试遍所有排列，只要存在一个可行排法就找得到。然后在全部
 * 可行排法里选**公平**的一版：对每个人，把「实际开始比 ta 的最早能开始晚多少」记
 * 为延误（delay ≥ 0，硬约束保证不早于 earliestStart），再除以 ta 自己的时长得到
 * 「偏离自己时长的比例」。目标是让**最坏的那个比例**最小（并列时再看总和），也就
 * 是短时长者优先靠前、长时长者垫后——不再按字典序把长时长者无条件排最前。人数很
 * 少（协商场景一般 2~6 人），穷举足够快。`latestStart` 只是多一条参与可行性判断的
 * 硬约束，不参与公平打分。
 *
 * 排不出返回 null。同样的输入永远给同样的输出（确定性）：分数相同时保留先枚举到
 * 的排列（字典序排列），不引入随机。
 */
export function allocateSlots(
  window: TimeWindow,
  free: readonly SlotConstraint[],
  fixed: readonly FixedSlot[] = []
): Assignment[] | null {
  if (free.length === 0) {
    return fixed.map((f) => ({ person: f.person, slot: { start: f.slot.start, end: f.slot.end } }));
  }

  const sorted = [...free].sort((a, b) => (a.person < b.person ? -1 : a.person > b.person ? 1 : 0));

  let best: Assignment[] | null = null;
  let bestWorst = Infinity;
  let bestTotal = Infinity;

  for (const order of permutations(sorted)) {
    const occupied = fixed.map((f) => ({ start: f.slot.start, end: f.slot.end }));
    const placed: Assignment[] = fixed.map((f) => ({
      person: f.person,
      slot: { start: f.slot.start, end: f.slot.end },
    }));
    // 自由人各自的安排，用于算公平分数（锚点不算：ta 的时段已被确认，不重新评判）。
    const placedFree: Array<{ constraint: SlotConstraint; slot: TimeSlot }> = [];

    let feasible = true;
    for (const c of order) {
      const slot = earliestFit(window, occupied, c.earliestStart, c.durationMinutes, c.latestStart);
      if (!slot) {
        feasible = false;
        break;
      }
      occupied.push(slot);
      occupied.sort((x, y) => x.start - y.start);
      placed.push({ person: c.person, slot });
      placedFree.push({ constraint: c, slot });
    }
    if (!feasible) continue;

    let worst = 0;
    let total = 0;
    for (const { constraint: c, slot } of placedFree) {
      // earliestFit 保证 slot.start >= c.earliestStart，所以 delay >= 0。
      const delay = slot.start - c.earliestStart;
      const ratio = delay / c.durationMinutes;
      if (ratio > worst) worst = ratio;
      total += ratio;
    }

    if (worst < bestWorst || (worst === bestWorst && total < bestTotal)) {
      bestWorst = worst;
      bestTotal = total;
      best = placed;
    }
  }

  return best;
}

/* ------------------------------------------------------------------ *
 * 不可行诊断：allocateSlots 排不出时，结构化地说出为什么
 * ------------------------------------------------------------------ */

/** 把「当天 00:00 起的分钟数」格式成 HH:MM（纯算术；分钟不是一天内也只是照常进位）。 */
function fmtMinute(m: Minute): string {
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

/**
 * 对「为什么排不出」做**确定性快速诊断**，返回一组 `Infeasibility`。纯函数，只做
 * 简单的算术检查，不调用 `allocateSlots` 本身（它是给 `step` 在 `allocateSlots` 已
 * 返回 null 之后、向调用方解释原因用的）。
 *
 * 检查顺序（能落到具体人的尽量落到具体人）：
 * 1. `duration_over_window` —— 自由人的时长 + 已确认锚点占用，合计已超过窗口长度；
 *    这是「总时长超窗口 → 需要有人压缩时长」的信号。
 * 2. `earliest_too_late` —— 某人「最早开始 + 时长」已超过窗口结束（即使窗口里没有
 *    别人也放不下）。
 * 3. `latest_before_earliest` —— 某人给的最晚开始早于自己的最早开始（自相矛盾）。
 * 4. 上面都不命中时，回退成 `no_fit_given_anchors` —— 锚点把窗口切出的空当放不下
 *    剩余人（含各自最早/最晚开始限制共同导致的排布失败）。
 *
 * 返回的是诊断数组：凡是命中的具体原因都会列出；只有一条也不要用空数组。
 */
export function diagnoseInfeasibility(
  window: TimeWindow,
  free: readonly SlotConstraint[],
  fixed: readonly FixedSlot[] = []
): Infeasibility[] {
  const windowLen = window.end - window.start;

  // 锚点对窗口的实际占用（只算落在窗口内的部分；正常情况下锚点都在窗口内）。
  let fixedLen = 0;
  for (const f of fixed) {
    const s = Math.max(f.slot.start, window.start);
    const e = Math.min(f.slot.end, window.end);
    if (e > s) fixedLen += e - s;
  }
  let freeLen = 0;
  for (const c of free) freeLen += c.durationMinutes;

  const reasons: Infeasibility[] = [];

  // 1) 总时长超窗口。
  const total = freeLen + fixedLen;
  if (total > windowLen) {
    reasons.push({
      kind: "duration_over_window",
      message:
        `所有人合计需占用 ${total} 分钟（自由人 ${freeLen} 分钟 + 已确认锚点 ${fixedLen} 分钟），` +
        `超出共享窗口 ${windowLen} 分钟（${fmtMinute(window.start)}–${fmtMinute(window.end)}），比窗口长 ${total - windowLen} 分钟`,
    });
  }

  // 2) 某人最早开始 + 时长已经超出窗口结束。
  for (const c of free) {
    if (c.earliestStart + c.durationMinutes > window.end) {
      reasons.push({
        kind: "earliest_too_late",
        person: c.person,
        message:
          `「${c.person}」最早只能 ${fmtMinute(c.earliestStart)}(${c.earliestStart}) 开始、需 ${c.durationMinutes} 分钟，` +
          `最早开始加时长到 ${fmtMinute(c.earliestStart + c.durationMinutes)}(${c.earliestStart + c.durationMinutes})，` +
          `已超过窗口结束 ${fmtMinute(window.end)}(${window.end})`,
      });
    }
  }

  // 3) 某人最晚开始早于最早开始（自己的时间范围就是空的）。
  for (const c of free) {
    if (c.latestStart !== undefined && c.latestStart < c.earliestStart) {
      reasons.push({
        kind: "latest_before_earliest",
        person: c.person,
        message:
          `「${c.person}」给的最晚开始 ${fmtMinute(c.latestStart)}(${c.latestStart}) ` +
          `早于最早开始 ${fmtMinute(c.earliestStart)}(${c.earliestStart})，自己的时间范围就是空的`,
      });
    }
  }

  // 4) 上面都不足以解释：锚点切碎的空当放不下剩余人。
  if (reasons.length === 0) {
    const available = Math.max(0, windowLen - fixedLen);
    reasons.push({
      kind: "no_fit_given_anchors",
      message:
        `已确认锚点共占 ${fixedLen} 分钟，窗口 ${fmtMinute(window.start)}–${fmtMinute(window.end)} 剩余 ${available} 分钟；` +
        `剩余自由人合计还需 ${freeLen} 分钟，受各自最早/最晚开始限制，锚点留下的空当放不下剩余人`,
    });
  }

  return reasons;
}

/**
 * 从窗口起点开始扫描空当，把 [earliest, earliest+duration) 放进最早能放下的空当。
 * `latestStart` 若给了：候选起点还必须 `<= latestStart`——一旦扫描到的空当起点已经
 * 晚于它，后面的空当只会更晚，直接判不可行。起点只会随扫描单调变晚，所以这是安全
 * 的提前终止。
 */
function earliestFit(
  window: TimeWindow,
  occupied: readonly TimeSlot[],
  earliestStart: Minute,
  duration: number,
  latestStart?: Minute
): TimeSlot | null {
  const withinLatest = (candidate: Minute): boolean =>
    latestStart === undefined || candidate <= latestStart;

  let cursor = window.start;
  for (const o of occupied) {
    if (o.end <= window.start || o.start >= window.end) continue;
    if (o.start > cursor) {
      const candidate = Math.max(cursor, earliestStart);
      if (!withinLatest(candidate)) return null;
      if (candidate + duration <= o.start) {
        return { start: candidate, end: candidate + duration };
      }
    }
    cursor = Math.max(cursor, o.end);
  }
  const candidate = Math.max(cursor, earliestStart);
  if (!withinLatest(candidate)) return null;
  if (candidate + duration <= window.end) {
    return { start: candidate, end: candidate + duration };
  }
  return null;
}

/** 字典序稳定地枚举全部排列（输入先按人名字典序排好）。 */
function* permutations<T>(xs: T[]): IterableIterator<T[]> {
  if (xs.length <= 1) {
    yield [...xs];
    return;
  }
  for (let i = 0; i < xs.length; i++) {
    const rest = [...xs.slice(0, i), ...xs.slice(i + 1)];
    for (const p of permutations(rest)) {
      yield [xs[i], ...p];
    }
  }
}

/* ------------------------------------------------------------------ *
 * reduce：事件日志 → 当前状态
 * ------------------------------------------------------------------ */

/**
 * 从事件日志重放推导当前状态（README：状态是派生的，不落库）。
 *
 * 薄封装：`stateFromSnap(fold(events))`。映射关系见 `stateFromSnap`。
 */
export function reduce(events: readonly Event[]): State {
  return stateFromSnap(fold(events));
}

/* ------------------------------------------------------------------ *
 * step：给定 历史事件 + Intent + 运行时上下文 → 追加事件 + 出站动作
 * ------------------------------------------------------------------ */

function noop(): StepResult {
  return { events: [], actions: [{ type: "none" }] };
}

function constraintOf(reported: Map<PersonId, Availability>, person: PersonId): SlotConstraint | null {
  const a = reported.get(person);
  if (!a) return null;
  return {
    person,
    earliestStart: a.start,
    durationMinutes: a.duration,
    ...(a.latestStart !== undefined ? { latestStart: a.latestStart } : {}),
  };
}

/**
 * 纯函数：给定历史事件日志 + 当前这条消息的 Intent（+ 谁发的、有哪些人、共享
 * 窗口），产出「要追加进日志的新事件」和「要发出的出站动作」。不落库、不读环境
 * 变量、不改传入的 events。
 *
 * Intent → 产出（README 转移表）：
 * - `report_availability`：追加事件；信息齐 → 排方案 `schedule_proposed` + 每人 propose。
 * - `confirm`：追加事件；全员确认 → `settled` + 每人 settle。
 * - `reject` / `counter_propose` / `add_constraint`：追加打断事件 → 重算 → 新版
 *   `schedule_proposed`（已确认的人钉死不动）。
 * - `ask_status`：对 pending 的人补 `reminded`（催一次，不重发 propose）。
 * - `other`：无状态转移。
 */
export function step(events: readonly Event[], intent: Intent, ctx: StepContext): StepResult {
  const base = fold(events);
  if (base.settled) return noop(); // 定案是终态，之后的消息不再驱动转移

  switch (intent.type) {
    case "other":
      return noop();
    case "ask_status":
      return stepAskStatus(events, base, ctx);
    case "confirm":
      return stepConfirm(events, base, ctx);
    case "report_availability":
    case "counter_propose":
    case "add_constraint":
      // 三种意图本质都是「更新自己的可用时间」：gathering 里是报到，已有方案里
      // 就是反提/加约束（要重排）。处理逻辑一致，只是当前阶段不同走不同分支。
      return stepAvailability(events, base, ctx, intent.start, intent.duration, intent.latestStart);
    case "reject":
      return stepRejectOrChange(events, base, ctx, intent.reason ?? null);
  }
}

/**
 * report_availability / counter_propose / add_constraint：更新某人的可用时间。
 *
 * - 还没有方案（gathering）：累计可用时间，全员报齐才排第一版。
 * - 已有方案在等确认：这等于反提/加约束，追加事件后重排（见 `stepRejectOrChange`）。
 *
 * `latestStart` 是该人「最晚必须开始」的上限（缺省 = 没有上限）；它与 start/duration
 * 一起构成这次「更新可用时间」的完整内容。
 */
function stepAvailability(
  events: readonly Event[],
  base: Snap,
  ctx: StepContext,
  start: Minute,
  duration: number,
  latestStart?: Minute
): StepResult {
  if (!ctx.participants.includes(ctx.sender)) return noop();

  // 报到与这个人已有的可用时间一字不差 = 没有新信息。不追加事件（否则会把它误判
  // 成一次反提，把已经确认的人静默解除确认——他只是把原话又说了一遍）。注意 latestStart
  // 也要一样才算真的一字不差：只补一条「不能晚于 X 点」的上限是有新信息的。
  const existing = base.reported.get(ctx.sender);
  if (
    existing &&
    existing.start === start &&
    existing.duration === duration &&
    existing.latestStart === latestStart
  ) {
    return noop();
  }

  const reportEvent: Event = {
    type: "availability_reported",
    person: ctx.sender,
    start,
    duration,
    ...(latestStart !== undefined ? { latestStart } : {}),
  };

  // 还没有方案 = gathering：累计可用时间，齐了才排第一版。
  if (!base.currentProposal) {
    const events2 = [...events, reportEvent];
    const s2 = fold(events2);
    const allReported = ctx.participants.every((p) => s2.reported.has(p));
    if (!allReported) {
      return { events: [reportEvent], actions: [{ type: "none" }] };
    }
    const free: SlotConstraint[] = [];
    for (const p of ctx.participants) {
      const c = constraintOf(s2.reported, p);
      if (!c) return { events: [reportEvent], actions: [{ type: "none" }] };
      free.push(c);
    }
    const plan = allocateSlots(ctx.window, free, []);
    if (!plan) {
      // 全员都报了但排不出可行方案：住户已报的事实照记（reportEvent 不丢），不硬发
      // 一版，也不静默沉默——发一条 blocked 诊断，让上层能拿到「为什么排不开」去协调。
      return { events: [reportEvent], actions: [{ type: "blocked", reasons: diagnoseInfeasibility(ctx.window, free) }] };
    }
    const proposalEvent: Event = {
      type: "schedule_proposed",
      window: ctx.window,
      assignments: plan,
    };
    return {
      events: [reportEvent, proposalEvent],
      actions: plan.map((a) => ({ type: "propose", person: a.person, slot: a.slot })),
    };
  }

  // 方案已存在时的再报到 = 更新约束并重排。
  return stepRejectOrChange(events, base, ctx, null, {
    start,
    duration,
    ...(latestStart !== undefined ? { latestStart } : {}),
  });
}

function stepConfirm(events: readonly Event[], base: Snap, ctx: StepContext): StepResult {
  if (!ctx.participants.includes(ctx.sender)) return noop();
  if (!base.currentProposal) return noop(); // 还没方案，没东西可确认
  if (!findAssignment(base.currentProposal.assignments, ctx.sender)) return noop();
  if (base.confirmed.has(ctx.sender)) return noop(); // 重复确认，直接去重

  const confirmEvent: Event = { type: "confirmed", person: ctx.sender };
  const events2 = [...events, confirmEvent];
  const s2 = fold(events2);

  if (s2.allConfirmed && s2.currentProposal) {
    const settledEvent: Event = {
      type: "settled",
      window: s2.currentProposal.window,
      assignments: s2.currentProposal.assignments,
    };
    return {
      events: [confirmEvent, settledEvent],
      actions: s2.currentProposal.assignments.map((a) => ({
        type: "settle",
        person: a.person,
        slot: a.slot,
      })),
    };
  }
  return { events: [confirmEvent], actions: [{ type: "none" }] };
}

/**
 * reject / 反提 / 加约束：追加打断事件（reject 追加 `rejected`；反提与加约束在本
 * 模块用 `availability_reported` 表达），然后把「仍确认的人」钉死、重排其余人。
 * 重排结果跟当前方案一样（等于没变化）或排不出时，不追加新版方案，停在
 * renegotiating，避免对同一件事反复 propose。
 *
 * `newAvailability` 非空时表示打断者同时给出了新的可用时间（counter/add）；
 * 里面可选的 `latestStart` 是该人「最晚必须开始」的上限。
 */
function stepRejectOrChange(
  events: readonly Event[],
  base: Snap,
  ctx: StepContext,
  reason: string | null,
  newAvailability?: { start: Minute; duration: number; latestStart?: Minute }
): StepResult {
  if (!ctx.participants.includes(ctx.sender)) return noop();

  // 没有方案时：反提/加约束已经在 stepAvailability 的 gathering 分支当作报到处理
  // 过，不会带着 newAvailability 走到这里；剩下没方案就 reject 没有意义。
  if (!base.currentProposal) return noop();
  if (!findAssignment(base.currentProposal.assignments, ctx.sender)) return noop();

  const disruptEvent: Event = newAvailability
    ? {
        type: "availability_reported",
        person: ctx.sender,
        start: newAvailability.start,
        duration: newAvailability.duration,
        ...(newAvailability.latestStart !== undefined ? { latestStart: newAvailability.latestStart } : {}),
      }
    : { type: "rejected", person: ctx.sender, ...(reason ? { reason } : {}) };

  const events2 = [...events, disruptEvent];
  const s2 = fold(events2);
  const proposal = s2.currentProposal;
  if (!proposal) return { events: [disruptEvent], actions: [{ type: "none" }] };

  // 锚点 = 打断信号之后仍然确认的人，时段沿用当前方案、原样保留。
  const anchors = new Set<PersonId>(s2.confirmed);
  const fixed: FixedSlot[] = [];
  for (const p of anchors) {
    const slot = findAssignment(proposal.assignments, p)?.slot;
    if (!slot) return { events: [disruptEvent], actions: [{ type: "none" }] };
    fixed.push({ person: p, slot });
  }

  const free: SlotConstraint[] = [];
  for (const p of ctx.participants) {
    if (anchors.has(p)) continue;
    const c = constraintOf(s2.reported, p);
    if (!c) return { events: [disruptEvent], actions: [{ type: "none" }] };
    free.push(c);
  }

  const plan = allocateSlots(ctx.window, free, fixed);
  if (!plan) {
    // 钉死已确认的人之后排不出：打断事件照记（disruptEvent 不丢），停在
    // renegotiating 不硬发，也不静默沉默——发一条 blocked 诊断让上层拿原因去协调。
    return { events: [disruptEvent], actions: [{ type: "blocked", reasons: diagnoseInfeasibility(ctx.window, free, fixed) }] };
  }
  if (sameAssignments(plan, proposal.assignments)) {
    // 结果跟被拒绝的这版一模一样：重发只是骚扰，不追加新方案。
    return { events: [disruptEvent], actions: [{ type: "none" }] };
  }

  const proposalEvent: Event = { type: "schedule_proposed", window: ctx.window, assignments: plan };
  // 锚点已经确认过、时段未变，不需要再发 propose；只发给还欠确认的人。
  const pendingActions = plan
    .filter((a) => !anchors.has(a.person))
    .map((a) => ({ type: "propose", person: a.person, slot: a.slot })) as OutboundAction[];
  return { events: [disruptEvent, proposalEvent], actions: pendingActions };
}

function stepAskStatus(events: readonly Event[], base: Snap, ctx: StepContext): StepResult {
  let pending: PersonId[];
  if (!base.currentProposal) {
    // gathering：还没报到的人
    pending = ctx.participants.filter((p) => !base.reported.has(p));
  } else if (base.lastDisruptIndex > base.lastProposalIndex) {
    // renegotiating：打断者已经回话、在等新版方案，不要催他确认
    pending = ctx.participants.filter(
      (p) => !base.confirmed.has(p) && !base.activeDisputants.has(p)
    );
  } else {
    // proposed：还欠确认的人
    pending = ctx.participants.filter((p) => !base.confirmed.has(p));
  }
  pending = pending.filter((p) => !base.reminded.has(p)); // 催一次，不重复问
  if (pending.length === 0) return noop();

  return {
    events: pending.map((p) => ({ type: "reminded", person: p }) as Event),
    actions: pending.map((p) => ({ type: "remind", person: p }) as OutboundAction),
  };
}

function sameAssignments(a: readonly Assignment[], b: readonly Assignment[]): boolean {
  if (a.length !== b.length) return false;
  for (const x of a) {
    const y = findAssignment(b, x.person);
    if (!y || !slotsEqual(x.slot, y.slot)) return false;
  }
  return true;
}

/* ------------------------------------------------------------------ *
 * checkInvariants：校验一份事件日志有没有违反硬约束
 * ------------------------------------------------------------------ */

/**
 * 校验事件日志的不变量，返回违规描述列表（空数组 = 通过）。机器自己产出的日志
 * 应该总是通过；这份检查主要用来挡手工构造/未来接入时不小心写坏的日志。
 *
 * 检查项：
 * - 每版方案/定案里：时段都在窗口内、一人只占一段、两两不重叠。
 * - `settled` 前该方案的每个人都已经确认（或跨版承袭确认）。
 * - 已确认的段不会被静默改动：两版方案之间，一个人上一版确认过、这版时段却变了，
 *   而他本人又没有 reject/反提 过 → 违规。
 */
export function checkInvariants(events: readonly Event[]): string[] {
  const violations: string[] = [];

  const checkWindowAndOverlap = (label: string, e: { window: TimeWindow; assignments: readonly Assignment[] }) => {
    const seen = new Set<PersonId>();
    const slots: TimeSlot[] = [];
    for (const a of e.assignments) {
      if (seen.has(a.person)) violations.push(`${label}：${a.person} 被分了两段`);
      seen.add(a.person);
      if (a.slot.start < e.window.start || a.slot.end > e.window.end || a.slot.start >= a.slot.end) {
        violations.push(`${label}：${a.person} 的时段 ${a.slot.start}-${a.slot.end} 超出窗口 ${e.window.start}-${e.window.end}`);
      }
      for (const o of slots) {
        if (overlaps(a.slot, o)) {
          violations.push(`${label}：${a.person} 的时段 ${a.slot.start}-${a.slot.end} 与另一段重叠`);
        }
      }
      slots.push(a.slot);
    }
  };

  for (const e of events) {
    if (e.type === "schedule_proposed") checkWindowAndOverlap("schedule_proposed", e);
    if (e.type === "settled") checkWindowAndOverlap("settled", e);
  }

  // settled 必须全员确认：对每个 settled 事件，看它出现时当前方案里是否人人已确认。
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.type !== "settled") continue;
    const s = fold(events.slice(0, i + 1));
    if (!s.currentProposal) {
      violations.push("settled 出现在没有任何方案之后");
      continue;
    }
    for (const a of e.assignments) {
      if (!s.confirmed.has(a.person)) {
        violations.push(`settled 时 ${a.person} 还没有确认`);
      }
    }
  }

  // 已确认段不被静默改动：两版连续方案之间对比。
  let prevProposalIdx = -1;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.type !== "schedule_proposed") continue;
    if (prevProposalIdx >= 0) {
      const prefix = fold(events.slice(0, i)); // 新方案之前的快照
      const prev = prefix.currentProposal;
      if (prev) {
        for (const p of prefix.confirmed) {
          const prevSlot = findAssignment(prev.assignments, p)?.slot;
          const newSlot = findAssignment(e.assignments, p)?.slot;
          if (!prevSlot || !newSlot || slotsEqual(prevSlot, newSlot)) continue;
          const selfDisrupted = events
            .slice(prevProposalIdx + 1, i)
            .some((ev) => (ev.type === "rejected" || ev.type === "availability_reported") && ev.person === p);
          if (!selfDisrupted) {
            violations.push(
              `${p} 已确认的时段 ${prevSlot.start}-${prevSlot.end} 被静默改成了 ${newSlot.start}-${newSlot.end}`
            );
          }
        }
      }
    }
    prevProposalIdx = i;
  }

  return violations;
}
