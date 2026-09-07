/**
 * LLM 意图解析（意图层真正的 LLM 实现）——**胶水层**。
 *
 * 协商状态机的分工（见 README.md）：LLM 只把住户说的一句话翻成一个结构化
 * `Intent`，真正的协调由 `machine.ts` 的确定性状态机完成。本文件是「翻译」的
 * LLM 版本，替换 `intent.ts` 里的确定性 stub 的思路。
 *
 * ## 层的位置
 *
 * - **允许依赖项目**：本文件会 import `@/lib/ai/providers` 的
 *   `getLanguageModel` + `ai` 的 `generateText`，这是有意为之的「胶水层」——
 *   它负责把项目现成的 LLM 访问方式接到协商状态机上。
 * - **核心保持零耦合**：`types.ts` / `machine.ts` / `intent.ts`（stub）不 import
 *   任何项目业务代码，可整体删除。将来不要因为这里依赖了项目，就顺手让核心也
 *   依赖项目。
 *
 * ## 与 stub 的分工
 *
 * stub 用关键词硬分，分不清「8 点可以」（回应方案=confirm）和「我 8 点有空」
 * （报到可用时间=report_availability）这类歧义——那正是交给 LLM 判断的地方。
 * 状态机那一层不关心解析器是 stub 还是 LLM，接口 `(message) => Intent` 不变。
 *
 * ## 失败语义
 *
 * 解析失败 / 不是 JSON / 模型调用异常 → 一律退化成 `{ type: "other" }`，不抛错。
 * 宁可让状态机把这句当噪音忽略，也不能因为解析层炸了把整个协商链路带崩。
 */

import { generateText } from "ai";
import { getLanguageModel } from "@/lib/ai/providers";
import type { Intent } from "./types";

/** 意图解析用哪个模型：便宜、快、听话，只做翻译不做推理。 */
export const COORDINATION_INTENT_MODEL = "deepseek/deepseek-v4-flash";

/** 消息里没写时长时的默认值（分钟）。解析层没有上下文，只能给个保守默认。 */
const DEFAULT_DURATION_MINUTES = 30;

/** 一天的分界：start 必须是 [0, 1440) 的整数分钟数。 */
const MINUTES_PER_DAY = 24 * 60;

const AVAILABILITY_TYPES = [
  "report_availability",
  "counter_propose",
  "add_constraint",
] as const;

type AvailabilityType = (typeof AVAILABILITY_TYPES)[number];

/** 系统提示词：把 7 种 Intent 讲清楚、只输出 JSON。逐字不变，可进 prompt cache。 */
const SYSTEM_PROMPT = [
  "你是多人排班协商里的“意图翻译器”。房东/室友在群里用一句话说跟排时间有关的事，",
  "你把这句话翻译成一个 JSON 意图。只输出一段 JSON，不要解释、不要代码块。",
  "",
  "可选意图 type：",
  "1. report_availability —— 报出/更新“自己几点能开始、要用多久”：通常是陈述自己的空闲",
  "（“我 X 点有空/能开始/开始做/用 Y 分钟”）。是提供信息，不是在对某个方案表态。",
  "2. confirm —— 同意、确认当前排好的方案：可以/行/没问题/同意/定案/就这版。",
  "即使提到钟点（如“8点可以”），也是“这个时段我接受”，不是重新报空闲。",
  "3. reject —— 明确拒绝当前方案，而且没有给任何替代时间。只表达“不行/不同意”，",
  "不带“几点开始/用多久”这类新信息。",
  "4. counter_propose —— 一边否定当前方案，一边给出自己新的可用时间",
  "（“不行，我 X 点才有空”“换到 X 点”“那 X 点吧”“X 点才行”）。拒绝 + 新时间。",
  "5. add_constraint —— 陈述一条新的可用性硬约束，重点是“最早/必须/只能 X 点以后才有空”、",
  "“我 X 点才到家/下班”。不一定要否定方案，是在补一条边界。",
  "6. ask_status —— 问排班进展、催人确认/回复：“排好了吗”“方案出来没”“催一下”“他回了吗”。",
  "7. other —— 其它无关/寒暄/说不准的话。",
  "",
  "时间换算成“当天 00:00 起的分钟数”：18:00=1080，18:30=1110，19:00=1140，",
  "19:30=1170，20:00=1200，21:00=1260，22:00=1320。",
  "duration 是“需要占用的分钟数”：半小时=30、一小时=60、45分钟=45、40分钟=40。",
  "话里没给时长时 duration 默认 30。",
  "这是晚上做饭/排班的语境：没写“早上/凌晨”的“6点/7点/8点”一律按晚上算",
  "（6点=1080，7点=1140，8点=1200）。",
  "",
  "JSON 形状（start/duration 必须是整数）：",
  '{"type":"report_availability","start":1110,"duration":30}',
  '{"type":"confirm"}',
  '{"type":"reject","reason":"这个时间不行"}',
  '{"type":"counter_propose","start":1140,"duration":60}',
  '{"type":"add_constraint","start":1170,"duration":45}',
  '{"type":"ask_status"}',
  '{"type":"other"}',
].join("\n");

/** 从 LLM 回复里抠最后一个能解析、且 type 合法、字段合理的 JSON 意图。 */
function parseIntentJson(raw: string): Intent | null {
  // Intent 是扁平 JSON（无嵌套花括号）。取**最后一个**能解析的对象：
  // 模型偶发会先写一段又自我纠正补一段，最后一段才是它真正想说的。
  const candidates = [...raw.matchAll(/\{[^{}]*\}/g)].map((m) => m[0]);
  for (let i = candidates.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(candidates[i]) as Record<string, unknown>;
      const intent = coerceIntent(parsed);
      if (intent) return intent;
    } catch {
      // 这一段 JSON 坏了，继续往前找上一段。
    }
  }
  return null;
}

function coerceToInt(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : null;
}

/** 把任意解析出的对象收敛成一个合法 Intent；不合法返回 null（调用方退化成 other）。 */
function coerceIntent(o: Record<string, unknown>): Intent | null {
  const type = typeof o.type === "string" ? o.type : "";
  if (type === "confirm") return { type: "confirm" };
  if (type === "ask_status") return { type: "ask_status" };
  if (type === "other") return { type: "other" };
  if (type === "reject") {
    const reason = typeof o.reason === "string" ? o.reason.trim() : "";
    return reason ? { type: "reject", reason } : { type: "reject" };
  }
  if ((AVAILABILITY_TYPES as readonly string[]).includes(type)) {
    const t = type as AvailabilityType;
    const start = coerceToInt(o.start);
    // 没有有效开始时间就没法排，宁可退化成 other 也不能塞一个 0 进去乱排。
    if (start === null || start < 0 || start >= MINUTES_PER_DAY) return null;
    const durRaw = coerceToInt(o.duration);
    const duration = durRaw === null ? DEFAULT_DURATION_MINUTES : durRaw;
    if (!(duration >= 1)) return null;
    return { type: t, start, duration };
  }
  return null;
}

/**
 * LLM 意图解析：把住户一句话翻译成结构化 Intent。
 *
 * - 解析成功 → 对应的 Intent（start 是当天 00:00 起的分钟数）。
 * - 解析失败 / 不是 JSON / 模型异常 → `{ type: "other" }`（不抛错）。
 *
 * 每次调用都会真实请求一次模型。意图很短、模型很便宜，单次开销可忽略。
 */
export async function llmParseIntent(message: string): Promise<Intent> {
  const text = (message ?? "").trim();
  if (!text) return { type: "other" };

  try {
    const result = await generateText({
      model: getLanguageModel(COORDINATION_INTENT_MODEL),
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: text }],
    });
    return parseIntentJson(result.text) ?? { type: "other" };
  } catch (error) {
    console.log(
      "[coordination/llm] 意图解析异常，退化为 other：",
      error instanceof Error ? error.message : String(error)
    );
    return { type: "other" };
  }
}
