import { convertToModelMessages, generateText, stepCountIs, type UIMessage } from "ai";
import { type RequestHints, systemPrompt } from "@/lib/ai/prompts";
import { getLanguageModel } from "@/lib/ai/providers";
import { findNearestTransit } from "@/lib/ai/tools/find-nearest-transit";
import { getTransitTime } from "@/lib/ai/tools/get-transit-time";
import { queryListings } from "@/lib/ai/tools/query-listings";
import { createSearchRentalTool } from "@/lib/ai/tools/search-rental";
import { createSearchWantedTool } from "@/lib/ai/tools/search-wanted";
import { DEFAULT_CHAT_MODEL } from "@/lib/ai/models";
import { getMessagesByChatId, saveMessages } from "@/lib/db/queries";
import type { DBMessage } from "@/lib/db/schema";
import { convertToUIMessages, generateUUID, stripMemoryFromDisplay } from "@/lib/utils";
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
}: {
  chatId: string;
  selectedChatModel?: string;
  requestHints: RequestHints;
  rememberedPrefs?: string | null;
  detectedLanguage?: string | null;
  /** 渠道追加的提示词（例如评论区那套"输出去评论区"的渠道规则） */
  extraSystem?: string;
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
      searchRental: createSearchRentalTool(chatId),
      searchWanted: createSearchWantedTool(chatId),
      queryListings,
      findNearestTransit,
      getTransitTime,
    },
    // 推理模型不给工具（沿用 /api/chat 的既有行为，别改）
    activeTools: isReasoningModel
      ? []
      : [
          "searchRental",
          "searchWanted",
          "queryListings",
          "findNearestTransit",
          "getTransitTime",
        ],
    isReasoningModel,
  };
}

/**
 * 跑完整一轮：存用户消息 → 带全量历史调模型 → 存助手消息 → 返回文本。
 *
 * **跨渠道上下文就是靠这里**：历史按 chatId 取，不管这些消息当初是从网页、
 * 小红书还是短信进来的。所以用户可以在小红书说"找 Sunnyvale"，短信补一句
 * "预算 1300"，网页再说"最好独卫"，模型看到的是同一串对话。
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

  const history = await getMessagesByChatId({ id: turn.chatId });

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

  const result = await generateText({
    model: setup.model,
    system: setup.system,
    messages: await convertToModelMessages(uiMessages),
    stopWhen: stepCountIs(CHAT_ENGINE_MAX_STEPS),
    tools: setup.tools,
  });

  const answer = stripMemoryFromDisplay(
    result.text.trim() ||
      result.steps
        .map((step) => step.text.trim())
        .filter(Boolean)
        .at(-1) ||
      ""
  );

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

  const toolsUsed = [
    ...new Set(
      result.steps.flatMap((step) => step.toolCalls.map((call) => call.toolName))
    ),
  ];
  const toolOutputs = result.steps.flatMap((step) =>
    step.toolResults.map((toolResult) => (toolResult as { output?: unknown }).output)
  );

  console.log(
    "[chat-engine]",
    JSON.stringify({
      chatId: turn.chatId,
      channel: turn.channel,
      toolsUsed,
      chars: answer.length,
      historyCount: history.length,
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
