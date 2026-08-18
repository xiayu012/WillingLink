import {
  adaptersEnabled,
  checkToken,
  handleInboundMessage,
  jsonWithCors,
  toErrorResponse,
} from "@/lib/chat/adapter";

export const maxDuration = 60;
export const preferredRegion = "sfo1";

export function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Xhs-Token",
    },
  });
}

/**
 * 小红书**私信** adapter —— 三个 adapter 里最完整的一个，另外两个照着抄。
 *
 * 与 `/api/xhs/comment-reply` 的分工（别搞混）：
 * - comment-reply：一次性的"帖子评论生成"，无状态，不进聊天记录。**保留**。
 * - 这条：真正的私信聊天，进同一套 Chat + Message_v2，跨渠道共用上下文。
 *
 * 上线前还要做的（现在故意留白）：
 * - 小红书那边怎么把私信推过来（集简云/自建轮询/官方回调），以及回复怎么发回去
 * - webhook 重投去重（externalMessageId 已经在链路里传，判重逻辑还没写）
 * - 限流：网页那条走 entitlements，这里还没有
 */
export async function POST(request: Request) {
  if (!adaptersEnabled()) {
    return jsonWithCors(
      { ok: false, error: "Channel adapters disabled (set CHANNEL_ADAPTERS_ENABLED=1)" },
      503
    );
  }
  if (!checkToken(request)) {
    return jsonWithCors({ ok: false, error: "Unauthorized" }, 401);
  }

  let payload: Record<string, unknown>;
  try {
    payload = await request.json();
  } catch {
    return jsonWithCors({ ok: false, error: "Invalid JSON" }, 400);
  }

  // 小红书侧字段名以后接通了再对齐，这里先用最直白的三个
  const externalUserId =
    typeof payload.userId === "string" ? payload.userId.trim() : "";
  const text = typeof payload.text === "string" ? payload.text.trim() : "";

  if (!externalUserId || !text) {
    return jsonWithCors(
      { ok: false, error: "userId and text are required" },
      400
    );
  }

  try {
    const result = await handleInboundMessage({
      channel: "xhs",
      externalUserId,
      text,
      accountId: typeof payload.accountId === "string" ? payload.accountId : null,
      externalMessageId:
        typeof payload.messageId === "string" ? payload.messageId : null,
    });

    return jsonWithCors({
      ok: true,
      chatId: result.chatId,
      reply: result.text,
      toolsUsed: result.toolsUsed,
      elapsedMs: result.elapsedMs,
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
