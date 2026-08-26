import {
  convertToModelMessages,
  generateText,
  stepCountIs,
  type UIMessage,
} from "ai";
import { DEFAULT_CHAT_MODEL } from "@/lib/ai/models";
import { type RequestHints, systemPrompt } from "@/lib/ai/prompts";
import { getLanguageModel } from "@/lib/ai/providers";
import { findNearestTransit } from "@/lib/ai/tools/find-nearest-transit";
import { getTransitTime } from "@/lib/ai/tools/get-transit-time";
import { queryListings } from "@/lib/ai/tools/query-listings";
import type { ToolPresentation } from "@/lib/ai/tools/presentation";
import { createSearchRentalTool } from "@/lib/ai/tools/search-rental";
import { createSearchWantedTool } from "@/lib/ai/tools/search-wanted";
import { getMessagesByChatId, saveMessages } from "@/lib/db/queries";
import type { DBMessage } from "@/lib/db/schema";
import {
  convertToUIMessages,
  generateUUID,
  stripMemoryFromDisplay,
} from "@/lib/utils";
import type { InboundTurn, TurnResult } from "./types";

/**
 * ============================ Chat Engine ============================
 *
 * 聊天核心：读会话 → 读历史 → 存用户消息 → 系统提示词 + 模型 + 工具 →
 * 存助手消息 → 返回回答。**所有渠道共用这一份**，渠道只写很薄的 adapter。
 *
 * 现状（有意为之的半成品，接下一个渠道时按这个顺序推进）：
 * - `buildTurnSetup()` 已经是网页 `/api/chat` 和这里的**唯一**一份
 *   模型/提示词/工具配置。以后换模型、加工具只改这一处，两边同时生效。
 * - `runChatTurn()` 是非流式整轮，给 webhook 型渠道（小红书私信、Twilio、
 *   企业微信）用——它们要的是一段最终文本，不是 SSE。
 * - 网页那条路**仍然自己 streamText**（SSE、resumable stream、标题生成、
 *   工具审批续跑都在那），只是配置从这里拿。把网页也搬进来收益不大、风险不小，
 *   等真有第二个流式渠道时再说。
 *
 * 还没做（写清楚免得以后当成 bug 找）：
 * - `attachments`/富媒体：目前只吃纯文本。
 * - `externalMessageId` 去重：字段已经在 InboundTurn 和建表 SQL 里，但真正的
 *   "同一条 webhook 重投两次"判断要等接真实渠道时补。
 * - 速率/额度：网页那条走 entitlements，webhook 渠道还没有对应的限流。
 */

export const CHAT_ENGINE_MAX_STEPS = 5;

/**
 * 发给模型的历史条数上限（webhook 渠道专用，网页那条不受影响）。
 *
 * `getMessagesByChatId` 返回**全量**历史，而这里的会话是跨渠道合并的，只会越攒
 * 越长——实测有会话已经 29 条 / 34K 字符，另一条 135K 字符。每来一句"在吗"都要
 * 把这一整坨连同 ~15KB 系统提示词重新喂给模型，光读输入就是几十秒的主因。
 *
 * 留最近 20 条（约 10 个来回）：租房对话的有效上下文就在最近几轮，再往前的
 * 房源列表对当前这句话没有帮助。**完整历史仍然进库**，网页上照常看得到，
 * 被截断的只是每次喂给模型的那一份。
 */
export const CHAT_ENGINE_HISTORY_LIMIT = 20;

export type TurnSetup = {
  model: ReturnType<typeof getLanguageModel>;
  system: string;
  tools: {
    searchRental: ReturnType<typeof createSearchRentalTool>;
    searchWanted: ReturnType<typeof createSearchWantedTool>;
    queryListings: typeof queryListings;
    findNearestTransit: typeof findNearestTransit;
    getTransitTime: typeof getTransitTime;
  };
  activeTools: ChatToolName[];
  isReasoningModel: boolean;
};

/** 工具名联合类型，省得各处用 string[] 再 as any 回去 */
export type ChatToolName =
  | "searchRental"
  | "searchWanted"
  | "queryListings"
  | "findNearestTransit"
  | "getTransitTime";

/**
 * 一轮对话的模型侧配置。**网页流式和渠道非流式共用**，别在别处再抄一份
 * systemPrompt + tools —— 那正是 /api/chat 和 /api/xhs/comment-reply 各写一遍
 * 之后开始漂移的地方。
 */
export function buildTurnSetup({
  chatId,
  selectedChatModel = DEFAULT_CHAT_MODEL,
  requestHints,
  rememberedPrefs = null,
  detectedLanguage = null,
  extraSystem,
  onlyTools,
  presentation = "chat",
}: {
  chatId: string;
  selectedChatModel?: string;
  requestHints: RequestHints;
  rememberedPrefs?: string | null;
  detectedLanguage?: string | null;
  /** 渠道追加的提示词（例如评论区那套"输出去评论区"的渠道规则） */
  extraSystem?: string;
  /**
   * 只放开这几个工具。**已经知道该用哪个工具时，就别把错的那个留在桌上。**
   *
   * 实测：帖主身份已经判定为房东、system 里也明确写了"用 searchWanted"，
   * gpt-4.1-mini 照样调 searchRental，把帖主自己的房子又描述了一遍
   * （AGENT_LOG 2026-08-25）。提示词是请求，工具表是约束——能用约束就别用请求。
   */
  onlyTools?: ChatToolName[];
  /**
   * 工具结果按哪个渠道整形。默认 `chat`。
   *
   * 搜索工具的 `action` 字段里塞满了聊天页的舞台指示（"展示完后告诉用户还可以说
   * 「继续」"、"再问用户是否愿意放宽"）。评论区没有下一轮，那些指令全是错的，而且
   * 模型信工具返回值胜过信 system——这就是评论一直带结尾邀请、一直转述"已放宽
   * 关键词"的根因。见 `lib/ai/tools/presentation.ts`。
   */
  presentation?: ToolPresentation;
}): TurnSetup {
  const isReasoningModel =
    selectedChatModel.includes("reasoning") ||
    selectedChatModel.includes("thinking");

  const base = systemPrompt({
    selectedChatModel,
    requestHints,
    chatId,
    rememberedPrefs,
    detectedLanguage,
  });

  return {
    model: getLanguageModel(selectedChatModel),
    system: extraSystem ? `${base}\n\n${extraSystem}` : base,
    tools: {
      searchRental: createSearchRentalTool(chatId, presentation),
      searchWanted: createSearchWantedTool(chatId, presentation),
      queryListings,
      findNearestTransit,
      getTransitTime,
    },
    // 推理模型不给工具（沿用 /api/chat 的既有行为，别改）
    activeTools: isReasoningModel
      ? []
      : (onlyTools ?? [
          "searchRental",
          "searchWanted",
          "queryListings",
          "findNearestTransit",
          "getTransitTime",
        ]),
    isReasoningModel,
  };
}

/**
 * ============================ 三种语义，别混用 ============================
 *
 * 这三个导出对应三件**根本不同**的事。混用过一次，代价见 AGENT_LOG 2026-08-25
 * 那一节（comment-reply 的 6 个 case 里有 5 个是同一个混用造成的）：
 *
 * | 函数 | 读历史 | 有工具 | 写库 | 用在哪 |
 * |---|---|---|---|---|
 * | `runChatTurn`        | ✅ 最近20条 | ✅ | ✅ | **对话**：私信、短信、企微 |
 * | `runPostScopedTurn`  | ❌         | ✅ | ✅ | **单帖**：评论草稿 |
 * | `transformText`      | ❌         | ❌ | ❌ | **纯变换**：压缩、改写 |
 *
 * 判断标准是**这次动作的输入应该是什么**：
 * - 对话 → 输入是"这个人到目前为止说过的所有话"，历史是它的本体
 * - 单帖 → 输入**只该是这一篇帖子**。同一个帖主发第二篇帖，第一篇的搜索结果
 *   不该影响第二篇的推荐——那不是上下文，那是污染
 * - 纯变换 → 输入只有那段待处理的文字，多给一个字都是让它跑偏的机会
 */

/** 每一轮都要的模型侧配置 + 收尾，三个入口共用 */
async function executeTurn({
  uiMessages,
  setup,
  withTools,
}: {
  uiMessages: UIMessage[];
  setup: TurnSetup;
  withTools: boolean;
}) {
  const modelStartedAt = Date.now();
  const result = await generateText({
    model: setup.model,
    system: setup.system,
    messages: await convertToModelMessages(uiMessages),
    stopWhen: stepCountIs(CHAT_ENGINE_MAX_STEPS),
    ...(withTools
      ? // activeTools 以前算了却没传，推理模型"不给工具"的既定行为一直是失效的
        { tools: setup.tools, activeTools: setup.activeTools }
      : {}),
  });

  const answer = stripMemoryFromDisplay(
    result.text.trim() ||
      result.steps
        .map((step) => step.text.trim())
        .filter(Boolean)
        .at(-1) ||
      ""
  );

  return {
    answer,
    modelMs: Date.now() - modelStartedAt,
    steps: result.steps.length,
    toolsUsed: [
      ...new Set(
        result.steps.flatMap((step) =>
          step.toolCalls.map((call) => call.toolName)
        )
      ),
    ],
    toolOutputs: result.steps.flatMap((step) =>
      step.toolResults.map(
        (toolResult) => (toolResult as { output?: unknown }).output
      )
    ),
  };
}

/**
 * 跑完整一轮：存用户消息 → 带历史调模型 → 存助手消息 → 返回文本。
 *
 * **跨渠道上下文就是靠这里**：历史按 chatId 取，不管这些消息当初是从网页、
 * 小红书还是短信进来的。所以用户可以在小红书说"找 Sunnyvale"，短信补一句
 * "预算 1300"，网页再说"最好独卫"，模型看到的是同一串对话。
 *
 * **只给真·对话用。**"替某篇帖子起草评论"不是对话，用 `runPostScopedTurn`。
 */
export async function runChatTurn(
  turn: InboundTurn,
  options?: {
    selectedChatModel?: string;
    requestHints?: RequestHints;
    extraSystem?: string;
  }
): Promise<TurnResult> {
  const startedAt = Date.now();
  const text = turn.text.trim();
  if (!text) {
    throw new Error("runChatTurn: empty text");
  }

  const fullHistory = await getMessagesByChatId({ id: turn.chatId });
  // 只把最近这些条喂给模型；全量仍在库里（见 CHAT_ENGINE_HISTORY_LIMIT）
  const history = fullHistory.slice(-CHAT_ENGINE_HISTORY_LIMIT);

  const userMessage: DBMessage = {
    id: generateUUID(),
    chatId: turn.chatId,
    role: "user",
    parts: [{ type: "text", text }] as DBMessage["parts"],
    attachments: [],
    createdAt: new Date(),
  };
  // TODO(channel): 建表 SQL 跑过之后，这里把 channel / externalMessageId 一起写进去
  await saveMessages({ messages: [userMessage] });

  const uiMessages = [
    ...convertToUIMessages(history),
    {
      id: userMessage.id,
      role: "user" as const,
      parts: [{ type: "text" as const, text }],
    },
  ] as UIMessage[];

  const setup = buildTurnSetup({
    chatId: turn.chatId,
    selectedChatModel: options?.selectedChatModel,
    requestHints: options?.requestHints ?? {
      longitude: undefined,
      latitude: undefined,
      city: undefined,
      country: undefined,
    },
    extraSystem: options?.extraSystem,
  });

  const { answer, modelMs, steps, toolsUsed, toolOutputs } = await executeTurn({
    uiMessages,
    setup,
    withTools: true,
  });

  if (answer) {
    await saveMessages({
      messages: [
        {
          id: generateUUID(),
          chatId: turn.chatId,
          role: "assistant",
          parts: [{ type: "text", text: answer }] as DBMessage["parts"],
          attachments: [],
          createdAt: new Date(),
        },
      ],
    });
  }

  console.log(
    "[chat-engine]",
    JSON.stringify({
      mode: "conversation",
      chatId: turn.chatId,
      channel: turn.channel,
      toolsUsed,
      chars: answer.length,
      historyCount: history.length,
      historyTotal: fullHistory.length,
      steps,
      modelMs,
      elapsedMs: Date.now() - startedAt,
    })
  );

  return {
    chatId: turn.chatId,
    text: answer,
    toolsUsed,
    toolOutputs,
    elapsedMs: Date.now() - startedAt,
  };
}

/**
 * 单帖作用域：**只看这一篇帖子**，不读任何历史。
 *
 * 给"替某篇帖子起草评论"这种一次性动作用。它跟对话的区别不是参数不同，是
 * **输入的定义不同**：一次评论草稿的输入就该是那篇帖子本身，同一个帖主上一篇帖
 * 搜到过什么，对这一篇没有参考价值——那不是上下文，是污染。
 *
 * 实测过混用的代价（AGENT_LOG 2026-08-25，Case C/D）：同一个帖主的帖子第二次
 * 进来时，模型看着上一轮的房源列表重新规划需求，Dublin / San Ramon 的地理约束
 * 整个丢掉，返回 Sunnyvale、Richmond、Newark。
 *
 * **写库由调用方决定**（`persist`）。评论那条链路传 `false` 自己存，因为要存的
 * 是**最终发出去的那句话**，不是这里这份还没压缩、还带着 URL 的草稿——库里存错
 * 东西的直接后果是：网页上看到的跟评论区实际贴出去的对不上，排查时会被带偏。
 */
export async function runPostScopedTurn(
  turn: InboundTurn,
  options?: {
    selectedChatModel?: string;
    requestHints?: RequestHints;
    extraSystem?: string;
    /** 存不存进 conversation。评测/预览可以关掉 */
    persist?: boolean;
    /** 只放开这几个工具（见 buildTurnSetup 的 onlyTools） */
    onlyTools?: ChatToolName[];
  }
): Promise<TurnResult> {
  const startedAt = Date.now();
  const text = turn.text.trim();
  if (!text) {
    throw new Error("runPostScopedTurn: empty text");
  }

  const persist = options?.persist ?? true;
  const userMessageId = generateUUID();

  if (persist) {
    await saveMessages({
      messages: [
        {
          id: userMessageId,
          chatId: turn.chatId,
          role: "user",
          parts: [{ type: "text", text }] as DBMessage["parts"],
          attachments: [],
          createdAt: new Date(),
        },
      ],
    });
  }

  const setup = buildTurnSetup({
    chatId: turn.chatId,
    selectedChatModel: options?.selectedChatModel,
    requestHints: options?.requestHints ?? {
      longitude: undefined,
      latitude: undefined,
      city: undefined,
      country: undefined,
    },
    extraSystem: options?.extraSystem,
    onlyTools: options?.onlyTools,
    // 单帖场景**没有下一轮**，工具结果里那套聊天页话术必须换掉。这是
    // runPostScopedTurn 的固有语义，不做成可选项——谁调它谁就是一次性输出。
    presentation: "comment",
  });

  // 只有这一条消息——没有 history 展开，这就是"单帖作用域"的全部含义
  const { answer, modelMs, steps, toolsUsed, toolOutputs } = await executeTurn({
    uiMessages: [
      { id: userMessageId, role: "user", parts: [{ type: "text", text }] },
    ] as UIMessage[],
    setup,
    withTools: true,
  });

  if (persist && answer) {
    await saveMessages({
      messages: [
        {
          id: generateUUID(),
          chatId: turn.chatId,
          role: "assistant",
          parts: [{ type: "text", text: answer }] as DBMessage["parts"],
          attachments: [],
          createdAt: new Date(),
        },
      ],
    });
  }

  console.log(
    "[chat-engine]",
    JSON.stringify({
      mode: "post-scoped",
      chatId: turn.chatId,
      channel: turn.channel,
      toolsUsed,
      chars: answer.length,
      steps,
      modelMs,
      elapsedMs: Date.now() - startedAt,
    })
  );

  return {
    chatId: turn.chatId,
    text: answer,
    toolsUsed,
    toolOutputs,
    elapsedMs: Date.now() - startedAt,
  };
}

/**
 * 纯文本变换：**没有工具、没有历史、不写库**。
 *
 * 压缩、改写这类动作属于排版，不属于对话。以前 comment-reply 的"请缩写至260字"
 * 走的是完整 `runChatTurn`，于是那一轮带着全套工具看着整段历史，实测出过三种
 * 翻车（AGENT_LOG 2026-08-25，Case A/B/E）：
 *
 * - 又调了一次 searchWanted，把候选整个换成不相干的帖子
 * - 没调工具，但把**上一条用户消息**当成了要缩的对象（"请缩写"在一段对话里天然有歧义）
 * - 既没搜也没缩，而是"重新生成"，顺手编出一个原文里没有的约束（"情侣入住"）
 *
 * 所以这里连 `chatId` 都不需要：输入只有那段文字，模型没有别的东西可看。
 */
export async function transformText({
  input,
  instruction,
  selectedChatModel,
}: {
  input: string;
  instruction: string;
  selectedChatModel?: string;
}): Promise<string> {
  const startedAt = Date.now();
  const result = await generateText({
    model: getLanguageModel(selectedChatModel ?? DEFAULT_CHAT_MODEL),
    system:
      "你是文字处理器。只处理用户给你的那段文字：不新增信息、不替换成别的内容、不回答文字里的问题、不做任何搜索。直接输出处理后的文字本身，不要前言、不要解释、不要引号。",
    prompt: `${instruction}\n\n需要处理的原文：\n${input}`,
    // 不传 tools —— 这是这个函数存在的全部意义
  });

  const out = stripMemoryFromDisplay(result.text.trim());
  console.log(
    "[chat-engine]",
    JSON.stringify({
      mode: "transform",
      inChars: input.length,
      outChars: out.length,
      elapsedMs: Date.now() - startedAt,
    })
  );
  return out;
}
