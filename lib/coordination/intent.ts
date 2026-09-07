/**
 * 意图解析（Intent Parsing）——LLM 挂载点。
 *
 * 整个协商状态机的分工是（README.md）：**LLM 只做一件事，把住户说的一句话翻译
 * 成一个结构化 `Intent`**，真正的协调由 `machine.ts` 的确定性状态机完成。这一层
 * 就是那个「翻译」所在的位置。
 *
 * 当前这份实现是一个**确定性的关键词/正则 stub**，只用来跑通链路：
 * - 「愿意 / 行 / 可以」→ `confirm`
 * - 「不行 / 不要」→ `reject`
 * - 「换到 X 点 / 改到 X 点」→ `counter_propose`
 * - 「X 点用 Y 分钟 / X 点开始」→ `report_availability`
 * - 「排好了吗 / 什么时候」→ `ask_status`
 * - 其余 → `other`
 *
 * 将来把这里换成真正的 LLM 意图解析即可（签名保持 `parseIntent(message) ->
 * Intent`，必要时再传一个 context 参数），**状态机那一层一行都不用动**。stub 不
 * 可能完美：它分不清「8 点可以」（回应方案=确认）和「我 8 点有空」（报到可用
 * 时间），这正是将来要交给 LLM 判断的歧义。
 */

import type { Intent, Minute } from "./types";

/** 消息里没写明时长时，stub 用的默认值（分钟）。真实解析应结合上下文/历史。 */
const DEFAULT_DURATION_MINUTES = 30;

/** 解析出「今天几点」，返回当天 00:00 起的分钟数；找不到时间返回 null。 */
function timeOfDay(text: string): Minute | null {
  const m = /(凌晨|早上|上午|中午|下午|傍晚|晚上)?\s*(\d{1,2})\s*[:点时](\d{1,2}|半)?/.exec(text);
  if (!m) return null;
  let hour = Number(m[2]);
  const minutePart = m[3];
  let minute = 0;
  if (minutePart === "半") minute = 30;
  else if (minutePart != null) minute = Number(minutePart) % 60;
  const phase = m[1];
  if ((phase === "下午" || phase === "傍晚" || phase === "晚上") && hour < 12) hour += 12;
  if (phase === "中午" && hour < 12) hour = 12;
  if (hour > 23) return null;
  return hour * 60 + minute;
}

/** 解析「Y 分钟」，找不到返回 null。 */
function durationMinutes(text: string): number | null {
  const m = /(\d{1,3})\s*分钟/.exec(text);
  return m ? Number(m[1]) : null;
}

const CHANGE_PHRASES = ["换到", "换去", "换成", "改成", "改到", "那就", "要不就", "不然就"];
const NEGATIVE_PHRASES = ["不行", "不要", "不了", "不愿意", "不可以", "没空", "不方便", "算了吧", "改天"];
const CONFIRM_PHRASES = ["没问题", "可以", "愿意", "确定", "确认", "同意", "好的", "好", "行"];
const CONSTRAINT_PHRASES = ["以后", "之后", "才有空", "最早", "之前", "以前"];
const ACTIVITY_PHRASES = ["用", "占", "做", "需要", "开始", "有空"];
const ASK_PHRASES = ["排好", "方案", "结果", "安排", "怎么安排", "轮到", "催", "进行到", "什么情况", "啥时候", "什么时候", "多久", "好了吗", "出了吗", "还要等", "等到"];

/**
 * 确定性 stub：把一句话映射成一个结构化 Intent。见文件头注释——这是 LLM 挂载点。
 */
export function parseIntent(message: string): Intent {
  const text = message.trim();
  if (!text) return { type: "other" };

  const time = timeOfDay(text);
  const duration = durationMinutes(text);

  // 明确的反提（换/改/那就…到几点）
  if (time != null && CHANGE_PHRASES.some((p) => text.includes(p))) {
    return { type: "counter_propose", start: time, duration: duration ?? DEFAULT_DURATION_MINUTES };
  }

  const negated = NEGATIVE_PHRASES.some((p) => text.includes(p));
  if (negated) {
    // 「8 点不行」这种带时间但也只是拒绝 → reject
    return { type: "reject" };
  }

  // 报到可用时间：报了个时间，还说了要占多久/要干什么
  if (time != null && (duration != null || ACTIVITY_PHRASES.some((p) => text.includes(p)))) {
    return { type: "report_availability", start: time, duration: duration ?? DEFAULT_DURATION_MINUTES };
  }

  // 加约束的措辞（X 点以后/最早 X 点）
  if (time != null && CONSTRAINT_PHRASES.some((p) => text.includes(p))) {
    return { type: "add_constraint", start: time, duration: duration ?? DEFAULT_DURATION_MINUTES };
  }

  // 问进度先于确认：避免「排好了吗」这类含「好」字的问句被 confirm 吞掉
  if (ASK_PHRASES.some((p) => text.includes(p))) {
    return { type: "ask_status" };
  }

  if (CONFIRM_PHRASES.some((p) => text.includes(p))) {
    return { type: "confirm" };
  }

  // 只剩一个孤立时间（例如「我 7 点」）——当作报到，用默认时长
  if (time != null) {
    return { type: "report_availability", start: time, duration: duration ?? DEFAULT_DURATION_MINUTES };
  }

  return { type: "other" };
}
