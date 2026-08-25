import "server-only";

import { resolveChatIdForUser } from "./conversation";
import { runChatTurn } from "./engine";
import { ChannelTableMissingError, resolveInternalUserId } from "./identity";
import type { ChannelId, TurnResult } from "./types";

/**
 * adapter 的公共骨架。
 *
 * 每个渠道的 route 只做三件事：**解析自己的字段 → 调 handleInboundMessage →
 * 把结果转成自己平台要的格式**（JSON / TwiML / 企业微信 XML）。身份、会话、
 * 模型、工具、存库全在下面这一条链里，渠道不重复实现。
 */

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Xhs-Token",
};

export function jsonWithCors(body: unknown, status = 200) {
  return Response.json(body, { status, headers: corsHeaders });
}

/**
 * 渠道 adapter 总开关。**默认关闭**：这些路由都是无鉴权入口，每次调用会跑一轮
 * 带搜索的 agent，没上线前不该能被人扫到就烧钱。要联调时在环境变量里打开。
 */
export function adaptersEnabled(): boolean {
  return process.env.CHANNEL_ADAPTERS_ENABLED === "1";
}

/** 可选的共享密钥，与 /api/xhs 系列同款 */
export function checkToken(request: Request): boolean {
  const expected = process.env.XHS_API_TOKEN?.trim();
  return !expected || request.headers.get("x-xhs-token") === expected;
}

export type InboundMessage = {
  channel: ChannelId;
  externalUserId: string;
  text: string;
  accountId?: string | null;
  displayName?: string | null;
  externalMessageId?: string | null;
  /**
   * 该渠道追加的提示词，拼在项目通用 system prompt 后面（见 `buildTurnSetup`）。
   * **渠道自己的运营话术放这里**，不要塞进通用 prompt——网页那条不该看到
   * "叫对方填联系方式"这种只对小红书成立的规则。
   */
  extraSystem?: string;
  /** 该渠道要用的模型，不给就走项目默认（`DEFAULT_CHAT_MODEL`） */
  selectedChatModel?: string;
};

/**
 * 一条外部消息走完全程：身份 → 会话 → Chat Engine → 回答。
 *
 * 注意**没有**"某渠道的会话"这一步：拿到内部 userId 之后就是同一条
 * conversation，跨渠道上下文就是这么来的。
 */
export async function handleInboundMessage(
  inbound: InboundMessage
): Promise<TurnResult> {
  const userId = await resolveInternalUserId({
    channel: inbound.channel,
    externalUserId: inbound.externalUserId,
    accountId: inbound.accountId ?? null,
    displayName: inbound.displayName ?? null,
  });

  const chatId = await resolveChatIdForUser({
    userId,
    title: `${inbound.channel} · ${inbound.displayName ?? inbound.externalUserId}`,
  });

  return await runChatTurn(
    {
      chatId,
      userId,
      text: inbound.text,
      channel: inbound.channel,
      externalMessageId: inbound.externalMessageId ?? null,
    },
    {
      extraSystem: inbound.extraSystem,
      selectedChatModel: inbound.selectedChatModel,
    }
  );
}

/** 把 adapter 里几种常见失败翻译成统一响应，省得每个渠道各写一遍 */
export function toErrorResponse(error: unknown) {
  if (error instanceof ChannelTableMissingError) {
    return jsonWithCors(
      { ok: false, error: error.message, needsMigration: true },
      501
    );
  }
  const name = error instanceof Error ? error.name : "UnknownError";
  const message = error instanceof Error ? error.message : String(error);
  // AI SDK 的错误对象别直接丢给 console.error（见 AGENT_LOG 的 fail-open 事故）
  console.log("[channel-adapter] failed", `${name}: ${message}`);
  return jsonWithCors({ ok: false, error: `Chat failed: ${name}` }, 502);
}
