/**
 * 协商状态机（Coordination State Machine）——类型定义。
 *
 * 本模块是「把多人用自然语言协调一件事（例如厨房排班）拿回确定性代码」的
 * 实验架构（见 README.md）。这套类型只依赖 TypeScript 语言本身，不 import
 * 项目里任何其它业务代码，可整体删除。
 *
 * 时间一律用**整数分钟**表示（可理解为「当天 00:00 起的分钟数」；把时间轴
 * 换成任意整数刻度也行，状态机只做纯算术，不做日期运算）。
 */

/** 分钟数（0..1439 表示一天内；状态机不关心上限，只做整数比较/加减） */
export type Minute = number;

/** 参与协商的人。只用字符串身份，本模块不碰数据库。 */
export type PersonId = string;

/** 一段连续时间 [start, end)，end 排他。 */
export interface TimeWindow {
  start: Minute;
  end: Minute;
}

/** 分配给某人的一个不重叠时段。 */
export interface TimeSlot {
  start: Minute;
  end: Minute;
}

/** 某人占用的时段：person + slot。 */
export interface Assignment {
  person: PersonId;
  slot: TimeSlot;
}

/**
 * 状态（README：派生状态，不落库）。
 *
 * - `gathering` —— 还没排出一版方案（还有人没报可用时间，或报了但排不出可行方案）。
 * - `proposed` —— 已排出一版方案，正在等人确认。
 * - `settled` —— 已定案（事件日志里有 settled）。
 * - `renegotiating` —— 有人拒绝/反提/加了新约束、但还没能重排出一版新方案。
 *
 * 「卡住 / 部分确认」这类更细的派生信息不单独存，由事件日志重放算出来。
 */
export type State = "gathering" | "proposed" | "settled" | "renegotiating";

/**
 * 事件（README：只追加、不可变）。字段名照 README。
 *
 * - `availability_reported` —— 某人报了可用时间。`start` 是**最早能开始**的分钟，
 *   `duration` 是需要占用的分钟数。
 * - `schedule_proposed` —— 排出一版方案（一次发给全员的那版）。
 * - `confirmed` / `rejected` —— 某人对**当前这版方案**确认/拒绝。
 * - `reminded` —— 系统催了一次某人（去重「催一次不重复问」用）。
 * - `settled` —— 全员确认，定案。
 *
 * 注意：反提（counter_propose）/加约束（add_constraint）这类意图在事件层用
 * `availability_reported` 表达——它们本质上都是「更新自己的可用时间」，而事件
 * 词表里没有第三种「改约束」事件。意图层保留细分，事件层保持 README 的六个词。
 *
 * `latestStart` 是「最晚必须开始」的分钟数，缺省表示没有上限。一个人报了它，就
 * 意味着他分到的时段起点不得晚于这个值（"八点太晚 / 我不接受八点 / 不能晚于八点
 * 开始"这类话的落点）。它与 `start`（最早能开始）合起来把可用起点圈成一个区间
 * [start, latestStart]。
 */
export type Event =
  | {
      /** 报可用时间：start 是最早能开始；latestStart 可选，是最晚必须开始，缺省表示没有上限。 */
      type: "availability_reported";
      person: PersonId;
      start: Minute;
      duration: number;
      latestStart?: Minute;
    }
  | { type: "schedule_proposed"; window: TimeWindow; assignments: Assignment[] }
  | { type: "confirmed"; person: PersonId }
  | { type: "rejected"; person: PersonId; reason?: string }
  | { type: "reminded"; person: PersonId }
  | { type: "settled"; window: TimeWindow; assignments: Assignment[] };

/**
 * 意图（README：LLM 的唯一职责，`parseIntent(message, context): Intent`）。
 *
 * 这是**可辨识联合**：每个成员用 `type` 区分，带各自需要的数据。真正解析时，
 * 「说话人是谁、共享窗口是什么、有哪些参与者」属于运行时上下文，不放进意图——
 * 它们由 `machine.step` 的 `StepContext` 传入。
 *
 * 三个 availability 类型（report_availability / counter_propose / add_constraint）
 * 各带一个可选的 `latestStart`：它是「最晚必须开始」的分钟数，缺省表示没有上限。
 * 「X 点太晚了 / 我不接受 X 点 / 不能晚于 X 点开始」这类话就该落在这里，而不是退
 * 化成无信息的 reject。
 *
 * 当前先用 intent.ts 里的确定性 stub 顶替 LLM；将来把 stub 换成 LLM 即可，
 * 状态机这一层不动。
 */
export type Intent =
  | { type: "report_availability"; start: Minute; duration: number; latestStart?: Minute }
  | { type: "confirm" }
  | { type: "reject"; reason?: string }
  | { type: "counter_propose"; start: Minute; duration: number; latestStart?: Minute }
  | { type: "add_constraint"; start: Minute; duration: number; latestStart?: Minute }
  | { type: "ask_status" }
  | { type: "other" };

/**
 * 出站动作：状态机判定「下一步该对谁说什么」的结果，由调用方（未来是短信/LLM
 * 层）真正发出去。`type:"none"` 表示这轮没有要发的消息。
 *
 * - `propose` —— 把方案里这个人分到的时段发给他，请他确认。
 * - `settle` —— 全员确认后，把定案时段发给每个人。
 * - `remind` —— 催一下 pending 的人（只催，不重发方案）。
 */
export type OutboundAction =
  | { type: "propose"; person: PersonId; slot: TimeSlot }
  | { type: "settle"; person: PersonId; slot: TimeSlot }
  | { type: "remind"; person: PersonId }
  | { type: "none" };
