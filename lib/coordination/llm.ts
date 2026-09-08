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
 *   依赖项目。（本文件 import `./machine` 的 `StateSnapshot` **类型**——只是类型，
 *   不是运行时依赖方向的反转；机器那一层完全不认识本文件。）
 *
 * ## 与 stub 的分工
 *
 * stub 用关键词硬分，分不清「8 点可以」（回应方案=confirm）和「我 8 点有空」
 * （报到可用时间=report_availability）这类歧义——那正是交给 LLM 判断的地方。
 * 状态机那一层不关心解析器是 stub 还是 LLM。
 *
 * ## 上下文感知（2026-09-07 起）
 *
 * 签名从 `(message) => Intent` 升级成 `(message, snapshot) => Intent`。`snapshot`
 * 是 `machine.projectState(events)` 重放投影出的**紧凑当前事实**（单一事实来源），
 * 每次只喂「状态快照 + 当前这一条消息」，绝不把全部聊天原文塞进 prompt。它解决
 * 两类无状态解析必然踩的坑：
 *
 * - 「我最早必须 18:00 开始」这类只改开始、不提时长的更新：沿用快照里这个人已报
 *   的 duration，不落回默认 30（否则会把别人报过的两小时悄悄覆盖掉）。
 * - 「不行 / 八点太晚了」到底在拒绝什么：用快照里的当前方案（谁被分到哪段）来消歧。
 *
 * ## 最近对话（recentDialogue，2026-09-07 加）
 *
 * 快照里还可选带 `recentDialogue`——由调用方（数据库回放脚本等）维护的**最近几条
 * 对话原文（含 AI 出站）**，上限很小（脚本截到 ~6 条、渲染层每条再截到 ~160 字），
 * 是「整段历史不进 prompt」这条规矩的唯一例外：它专门用来补「一句话在回什么」的
 * 指代——例如小五的「不合适。八点太晚了」，只有看到 AI 刚跟她说过「你最早只能排
 * 到 8 点后：20:00 到 20:30」，才知道她拒的是那档、而不是凭空报了个「八点有空」。
 * 状态机本身不依赖它做任何转移，只是透传进快照给本层看。
 *
 * ## 失败语义
 *
 * 解析失败 / 不是 JSON / 模型调用异常 → 一律退化成 `{ type: "other" }`，不抛错。
 * 宁可让状态机把这句当噪音忽略，也不能因为解析层炸了把整个协商链路带崩。
 */

import { generateText } from "ai";
import { getLanguageModel } from "@/lib/ai/providers";
import type { StateSnapshot } from "./machine";
import type { Intent } from "./types";

/** 意图解析用哪个模型：便宜、快、听话，只做翻译不做推理。 */
export const COORDINATION_INTENT_MODEL = "deepseek/deepseek-v4-flash";

/** 消息里没写时长、且快照里这个人也从没报过时长时的默认值（分钟）。 */
const DEFAULT_DURATION_MINUTES = 30;

/** 一天的分界：start 必须是 [0, 1440) 的整数分钟数。 */
const MINUTES_PER_DAY = 24 * 60;

/* ------------------------------------------------------------------ *
 * fastIntent：高置信度确定性快速路径（不调 LLM）
 * ------------------------------------------------------------------ */

/**
 * 纯寒暄/无信息 → `{ type: "other" }`。无论协商走到哪一步，这些词都不携带可行动作
 * （报时间/确认/拒绝/催办），机器当没听见即可。注意「嗯」是最软的承认语：在回应
 * 方案时它**有可能**被读成确认——正因为这种读法既不可靠又危险（把一版方案定在含糊
 * 的「嗯」上），这里刻意归 other，宁可让它多等一轮催办，也不把一个不确定的 ack 当
 * 成正式同意。
 */
const OTHER_WORDS = new Set([
  "在吗",
  "你好",
  "您好",
  "hi",
  "hello",
  "早上好",
  "中午好",
  "晚上好",
  "谢谢",
  "多谢",
  "嗯",
]);

/**
 * 纯确认 → `{ type: "confirm" }`。这些词只在「回应当前一版方案、表示接受」这一种
 * 语义下成立；后两个是「可以，没问题 / 没问题，可以」去标点后的常见组合。
 *
 * 注意“纯”的边界：若最近对话里 AI 刚**征询/建议过一个具体时间**（“17:30 先做，这个
 * 点方便吗”），住户回“可以/没问题”更可能是「接受那个建议时间」而不是对方案的
 * confirm——那种句子由 `llmParseIntent` 用上下文闸拦下、交给 LLM 消歧；`fastIntent`
 * 本身只看词形、不越权（见 `aiRecentlySuggestedTimeToSender`）。
 */
const CONFIRM_WORDS = new Set([
  "可以",
  "行",
  "好的",
  "好",
  "没问题",
  "同意",
  "ok",
  "是的",
  "对",
  "中",
  "成交",
  "可以没问题",
  "没问题可以",
]);

/**
 * 剥除用的装饰性标点/空白（整句归一化时逐字去掉）。中文字符单码点，`includes` 按
 * 字判断足够；不做正则，避免字符类转义坑。
 *
 * 疑问号/波浪号也在剥除表里（否则 `在吗？` 归一化后带个 `？` 就匹配不上 `在吗`），
 * 但它们的**语义翻转**已在 `fastIntent` 里用对原始串的前置检查拦住：归一化前先看
 * 原始串有没有问号/波浪号，确认词带问号（可以？=在问）一律交回 LLM。剥除本身只做
 * 字形归整，不负责语义安全。
 */
const DECORATIVE = [
  " ", "\t", "\r", "\n", "\u3000", // 空白 + 全角空格
  ",", ".", ";", ":", "!", "'", '"', "(", ")", "[", "]", "{", "}", "<", ">", "/", "\\",
  "、", "，", "。", "！", "；", "：", "…", "—", "–", "·", // 中文句读/省略/连接号
  "“", "”", "‘", "’", "「", "」", "『", "』", "【", "】", "《", "》", "〈", "〉", "（", "）",
  "？", "?", "～", "~",
].join("");

/**
 * 去掉装饰性标点/空白后整体转小写（ASCII）。数字、汉字、语气词（吗/呢/吧/啊）都
 * 是「字母」，不会被剥掉——这正是保守性的来源：任何带时间/数字/否定/换时段成分的
 * 句子剥完后都进不了下面的精确词表，只能落回 LLM。
 */
function normalizeForMatch(text: string): string {
  const chars: string[] = [];
  for (const ch of text) {
    if (DECORATIVE.includes(ch)) continue;
    chars.push(ch);
  }
  return chars.join("").toLowerCase();
}

/**
 * 高置信度确定性意图：只拦截**绝对无歧义的整句**（纯寒暄、纯确认、空串/只标点），
 * 命中返回对应 Intent，否则返回 null（由调用方继续走 LLM）。
 *
 * 纯确认词（可以/行/没问题）的“绝对无歧义”只在没有「AI 刚征询过具体时间」的上下文
 * 时才成立；那种上下文由 `llmParseIntent` 拦截、交回 LLM（见
 * `aiRecentlySuggestedTimeToSender`）。
 *
 * 保守性设计：先把整句剥成「只含字母」的规范形，再对整个规范形**精确匹配**有限
 * 词表。因为剥除只动标点/空白、绝不动数字和汉字——`八点可以` / `不行` / `排好了吗` /
 * `我7点用30分钟` 这类带时间、数字、否定或语气词的句子，剥完后必然不是词表成员，
 * 直接返回 null，绝不抢 LLM 的活。需要单独前置检查的、会被剥掉而语义翻转的信号：
 * 疑问号会让确认词从「接受」翻成「在问」（`可以？` → null）；波浪号表犹豫（`可以～`
 * → null）。寒暄类词即使带疑问号（`在吗？`）语义仍是无信息的 other，不受影响。
 *
 * 空串 / 只含标点 → `{ type: "other" }`。
 */
export function fastIntent(message: string): Intent | null {
  const trimmed = message.trim();
  if (!trimmed) return { type: "other" };

  // 疑问/犹豫是「含歧义信号 → null」的硬闸：剥标点会把 `可以？` 的语义从「在问」
  // 翻转成「确认」，所以疑问号必须在归一化前检测、命中即交回 LLM。寒暄类词带疑问号
  // （在吗？）语义仍是无信息的 other，不受影响——词表命中时只拦确认词的带问号形式。
  const hasQuestion = /[?？]/.test(trimmed);
  if (/[~～]/.test(trimmed)) return null;

  const norm = normalizeForMatch(trimmed);
  if (!norm) return { type: "other" };
  if (OTHER_WORDS.has(norm)) return { type: "other" };
  if (CONFIRM_WORDS.has(norm)) {
    // 确认词 + 疑问号（可以？/行？/好的？）= 在问对方，不是在接受，交给 LLM。
    if (hasQuestion) return null;
    return { type: "confirm" };
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * 上下文闸：纯确认词在「AI 刚征询/建议过一个具体时间」时不能被 fastIntent 短路
 * ------------------------------------------------------------------ */

/**
 * AI 出站里“正在征询/建议一个新时间”的口气词——而不是在通知已经定好的方案。命中其一、
 * 且句子里看得到钟点，就说明住户这句“可以/行/没问题”可能是「接受那个建议时间」，
 * 而不是对已排好方案的 confirm（真伪由 LLM 按 SYSTEM_PROMPT 判，这里只决定要不要叫
 * LLM）。
 */
const TIME_SUGGESTION_MARKERS = [
  "方便吗", "行吗", "可以吗", "好吗", "行不行", "行得通", "怎么样", "可否",
  "能不能", "可不可以", "要不要", "要不", "走法", "愿意吗", "愿不愿意",
  "挪到", "改到", "提前到", "您看", "你看",
] as const;

/** 句子里带钟点/时刻的说法（阿拉伯数字、几点、点半、“这个点/那个点”）。 */
const HAS_TIME_HINT = /[0-9０-９]|几点|点半|这个点|那个点/;

/**
 * 快照的【最近对话】里，AI 是否刚对这个发消息的人“征询/建议过一个具体开始时间”。
 * 是 → 住户只回纯确认词时，不能短路成 confirm，应交给 LLM 按上下文消歧。
 *
 * 只看 AI→这个人 的出站行；普通“通知定案”（排好了/定了/你的时段是 X）没有上面的征询
 * 口气词，不会在这里触发，仍按纯确认短路。
 */
function aiRecentlySuggestedTimeToSender(s: StateSnapshot): boolean {
  const sender = s.sender;
  if (!sender) return false;
  const dial = s.recentDialogue;
  if (!dial || dial.length === 0) return false;
  const prefix = `AI→${sender}：`;
  for (const line of dial) {
    if (!line.startsWith(prefix)) continue;
    if (TIME_SUGGESTION_MARKERS.some((m) => line.includes(m)) && HAS_TIME_HINT.test(line)) {
      return true;
    }
  }
  return false;
}

const AVAILABILITY_TYPES = [
  "report_availability",
  "counter_propose",
  "add_constraint",
] as const;

type AvailabilityType = (typeof AVAILABILITY_TYPES)[number];

/** 系统提示词：把 7 种 Intent 讲清楚、教它怎么用快照消歧、只输出 JSON。逐字不变，可进 prompt cache。 */
const SYSTEM_PROMPT = [
  "你是多人排班协商里的“意图翻译器”。你会先拿到一段【当前状态】（系统根据排班进展",
  "算出的紧凑事实），再拿到住户当前说的一句话。把这句话翻译成一个 JSON 意图。",
  "只输出一段 JSON，不要解释、不要代码块。",
  "",
  "可选意图 type：",
  "1. report_availability —— 报出/更新“自己几点能开始、要用多久”：通常是陈述自己的空闲",
  "（“我 X 点有空/能开始/开始做/用 Y 分钟”）。是提供信息，不是在对某个方案表态。",
  "2. confirm —— 同意、确认当前排好的方案：可以/行/没问题/同意/定案/就这版。",
  "即使提到钟点（如“8点可以”），也是“这个时段我接受”，不是重新报空闲。",
  "例外：若“可以/行/没问题”是在回应 AI 刚建议/征询的一个**具体新时间**（如“17:30 先",
  "做，这个点方便吗”），那是接受那个建议、等于更新自己的可用时间，不是 confirm（见下）。",
  "3. reject —— 明确拒绝当前方案，而且没有给任何替代时间。只表达“不行/不同意/不合适”，",
  "不带“几点开始/用多久”这类新信息。",
  "4. counter_propose —— 一边否定当前方案，一边给出自己新的可用时间",
  "（“不行，我 X 点才有空”“换到 X 点”“那 X 点吧”“X 点才行”）。拒绝 + 新时间。",
  "5. add_constraint —— 陈述一条新的可用性硬约束，重点是“最早/必须/只能 X 点以后才有空”、",
  "“我 X 点才到家/下班”。不一定要否定方案，是在补一条边界。",
  "6. ask_status —— 问排班进展、催人确认/回复：“排好了吗”“方案出来没”“催一下”“他回了吗”。",
  "7. other —— 其它无关/寒暄/说不准的话。",
  "",
  "用【当前状态】消歧（重要）：",
  "- 若给了【最近对话】，先用它判断这句话在回什么：看到 AI 刚建议过某个时段",
  "  （如“你最早只能排到8点后：20:00到20:30”），住户接的“不行/不合适/太晚了/不接",
  "  受八点”就是对**那条建议、那个时段**的拒绝或补上限——不要把它凭空当成一个",
  "  新的可用开始时间，也别脱离【最近对话】另找靶子。",
  "- 【接受时间建议 ≠ confirm】若【最近对话】里 AI 刚给这个人**建议/征询过一个具体开始",
  "  时间**（“还有个走法：您排最前头，17:30 到 18:00 先做，这个点您方便吗”“能不能改到",
  "  17:30”“您 17:30 这档方便吗”这类），住户只回“可以/行/没问题/好/同意”等确认，是",
  "  在**接受那个建议时间**——不是 confirm（confirm 只表示接受**已经排好的方案**）。",
  "  应输出 report_availability 或 counter_propose：start = AI 建议里的那个具体时间",
  "  （换算成分钟数），duration 沿用【每人已报】里这个人已报的时长、没报过才用默认 30；",
  "  不要凭空再造一个别的时间。",
  "- 反过来，若 AI 只是在**通知已经排好的方案**（“排好了/定稿了/定了/你的时段是 X”），",
  "  住户的“可以/没问题”才是 confirm。判别依据是 AI 那句的口气：是“征询/建议一个新",
  "  时间”（方便吗/行吗/可以吗/能不能改/有个走法/要不要挪到），还是“通知已定案”——",
  "  优先看有没有征询/建议的口气。",
  "- 【发消息的人】就是正在说这句话的人；消息里的“我”都指 ta。",
  "- 若这句话在报/改自己的可用时间，只给了“几点开始”、没给时长：沿用【每人已报】里",
  "  这个发消息的人之前报过的时长；ta 之前没报过才用默认 30。",
  "- 已有方案在等人确认时：不带新时间的“不行/不合适”是对自己分到的那段 reject；",
  "  带新时间（“不行，我 X 点才行”“换到 X 点”）是 counter_propose；住户回的",
  "  “可以/没问题”是对方案的 confirm（除非是在回应 AI 刚建议/征询的一个**新时间**——",
  "  那是上面的【接受时间建议≠confirm】）。",
  "- “X 点太晚了 / 我不接受 X 点 / 不能晚于 X 点开始 / X 点才开始就来不及了”这类用",
  "  钟点表达“不能再晚”的话，是在给自己加**最晚开始**上限，不是无信息的 reject，也",
  "  不是在报一个新的可用开始时间。输出带 latestStart 的意图（add_constraint 或",
  "  counter_propose 都行，机器等价）：latestStart = X 点对应的分钟数；start 沿用",
  "  【每人已报】里这个人已报的 start（没报过 start 就沿用当前方案分给他的时段起点，",
  "  还没有方案就取共享窗口起点）；duration 沿用已报值、没报过用默认 30。",
  "- 光一句“不行 / 不合适 / 我安排不了”、不带任何新时间或钟点的，才是 reject。",
  "- “X 点太早了”是嫌“X 点开始太早、要晚点才开始”：把**最早能开始**往后调",
  "  （counter_propose 带一个更晚的 start），不要设 latestStart。",
  "- “最早/必须/只能 X 点以后才有空”“X 点才到家/下班”才是加“最早开始”的",
  "  add_constraint（给 start，不带 latestStart）。",
  "",
  "时间换算成“当天 00:00 起的分钟数”：18:00=1080，18:30=1110，19:00=1140，",
  "19:30=1170，20:00=1200，20:30=1230，21:00=1260，22:00=1320。",
  "duration 是“需要占用的分钟数”：半小时=30、一小时=60、45分钟=45、40分钟=40、",
  "一个半小时=90、两个小时=120。话里没给时长时按上面的消歧规则（沿用已报或默认 30）。",
  "latestStart 是“最晚必须开始”的分钟数：只有“不能晚于 X 点开始 / X 点太晚 / 不接",
  "受 X 点”这类才给；没说不带。",
  "这是晚上做饭/排班的语境：没写“早上/凌晨”的“6点/7点/8点”一律按晚上算",
  "（6点=1080，7点=1140，8点=1200）。",
  "",
  "JSON 形状（start/duration/latestStart 必须是整数分钟数；latestStart 可选）：",
  '{"type":"report_availability","start":1110,"duration":30}',
  '{"type":"confirm"}',
  '{"type":"reject","reason":"这个时间不行"}',
  '{"type":"counter_propose","start":1140,"duration":60}',
  '{"type":"add_constraint","start":1170,"duration":45}',
  '{"type":"add_constraint","start":1080,"duration":30,"latestStart":1200}',
  '{"type":"ask_status"}',
  '{"type":"other"}',
].join("\n");

/** 分钟数 → "HH:MM"。 */
function fmtMinute(minute: number): string {
  const h = Math.floor(minute / 60);
  const m = minute % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** 按码点截断到约 max 个字，超长补 "…"（避免把聊天原文整段塞进 prompt）。 */
function truncateAt(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  return `${chars.slice(0, max).join("")}…`;
}

/**
 * 把 `projectState(events)` 的紧凑快照渲染成一段中文状态说明。只放解析这一条消息
 * 必需的事实：状态、窗口、发消息的人、每人已报、当前方案、已确认/还在等，末尾再附
 * 一段由调用方提供的【最近对话】（仅列出 `recentDialogue` 里的条目，每条截到约
 * 160 字），供模型判断「这句话在回什么」。每个时间都附上分钟数，免得模型再心算
 * 18:00=1080 之类的换算。
 */
function renderSnapshot(s: StateSnapshot): string {
  const lines: string[] = [];
  lines.push(`【当前协商状态】${s.state}${s.settled ? "（已定案）" : ""}`);
  if (s.window) {
    lines.push(
      `共享窗口：${fmtMinute(s.window.start)}(=${s.window.start}) – ${fmtMinute(s.window.end)}(=${s.window.end})`
    );
  }
  lines.push(`发消息的人：${s.sender ?? "未知"}`);
  lines.push(`参与者：${s.participants.length ? s.participants.join("、") : "（暂无）"}`);
  if (s.reported.length > 0) {
    lines.push("每人已报（最早能开始 + 需用时长；如标了最晚必须开始会写出来）：");
    for (const r of s.reported) {
      const latest =
        r.latestStart !== undefined ? `，且不能晚于 ${fmtMinute(r.latestStart)}(=${r.latestStart}) 开始` : "";
      lines.push(`- ${r.person}：${fmtMinute(r.start)}(=${r.start}) 起，${r.duration} 分钟${latest}`);
    }
  } else {
    lines.push("每人已报：还没人报到可用时间");
  }
  if (s.proposal && s.proposal.assignments.length > 0) {
    lines.push("当前方案（正在等人确认的分配）：");
    for (const a of s.proposal.assignments) {
      lines.push(
        `- ${a.person}：${fmtMinute(a.slot.start)}(=${a.slot.start}) – ${fmtMinute(a.slot.end)}(=${a.slot.end})`
      );
    }
  } else {
    lines.push("当前方案：还没排出来");
  }
  lines.push(`已确认：${s.confirmed.length ? s.confirmed.join("、") : "无"}`);
  lines.push(`还在等：${s.waiting.length ? s.waiting.join("、") : "无"}`);
  if (s.reminded.length > 0) lines.push(`已催过：${s.reminded.join("、")}`);
  if (s.recentDialogue.length > 0) {
    lines.push("最近对话（用于判断“这句话在回什么”；AI→某人 是 AI 说出站原文）：");
    for (const line of s.recentDialogue) lines.push(`- ${truncateAt(line, 160)}`);
  }
  return lines.join("\n");
}

function buildUserPrompt(snapshot: StateSnapshot, message: string): string {
  return `${renderSnapshot(snapshot)}\n\n【待解析消息】\n${message}`;
}

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
    // latestStart 可选：必须是合法分钟数（整数、在一天内）才保留，否则丢弃为无上限。
    const latestRaw = coerceToInt(o.latestStart);
    const latestStart =
      latestRaw !== null && latestRaw >= 0 && latestRaw < MINUTES_PER_DAY ? latestRaw : undefined;
    return {
      type: t,
      start,
      duration,
      ...(latestStart !== undefined ? { latestStart } : {}),
    };
  }
  return null;
}

/**
 * 上下文感知的 LLM 意图解析：把住户一句话翻译成结构化 Intent。
 *
 * - `snapshot` 是 `machine.projectState(当前已累积 events)` 的紧凑投影（含发消息的
 *   人是谁）。解析只吃这份快照 + 当前消息，不吃历史原文。
 * - 解析成功 → 对应的 Intent（start 是当天 00:00 起的分钟数）。
 * - 解析失败 / 不是 JSON / 模型异常 → `{ type: "other" }`（不抛错）。
 *
 * 先走 `fastIntent` 确定性快速路径：只有「无论上下文如何都只有一种解」的整句
 * （纯寒暄/纯确认/空串）会被拦截，**不花一次模型调用**。拦截不了才真实请求模型。
 * 语义不变——快路径只抢走绝对无歧义的句子，带任何歧义信号的都继续走 LLM。
 *
 * 唯一的例外是「纯确认词 + 最近对话里 AI 刚征询/建议过一个具体时间」：这种“可以/没
 * 问题”可能是「接受 AI 建议的那个时间」（=更新自己的可用时间），不是对已排方案的
 * confirm——上下文歧义，快路径不能短路，必须交给 LLM 用【最近对话】消歧。
 */
export async function llmParseIntent(message: string, snapshot: StateSnapshot): Promise<Intent> {
  const text = (message ?? "").trim();
  if (!text) return { type: "other" };

  const fast = fastIntent(text);
  if (fast && !(fast.type === "confirm" && aiRecentlySuggestedTimeToSender(snapshot))) return fast;

  try {
    const result = await generateText({
      model: getLanguageModel(COORDINATION_INTENT_MODEL),
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: buildUserPrompt(snapshot, text) }],
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
