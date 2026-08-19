import {
  checkToken,
  handleInboundMessage,
  jsonWithCors,
  toErrorResponse,
} from "@/lib/chat/adapter";
import { redactContactInfo } from "@/lib/chat/redact-contact";

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
 * 小红书私信 adapter。
 *
 * MVP 只认两个字段：
 *   { "id": "<小红书用户 id>", "text": "<对方说的话>" }
 *
 * 拿到之后走的是公共链路（`lib/chat/adapter.ts`）：外部身份 → 内部 user →
 * **那个人唯一的一条 conversation** → Chat Engine。所以同一个 id 第二次发消息
 * 接的是同一串上下文；这个人如果还从帖子评论（comment-reply）来过，也是同一条会话。
 *
 * 这一层唯一的渠道策略：**出站剔除联系方式**。项目 AI 的回答里常带着房源原文
 * 里的微信号和电话（库里就是这么存的），发进私信既像营销号，也等于替房东在平台
 * 外导流。剔除只作用于**发出去的那份**，会话记录里仍是完整原文，网页上照常能看。
 *
 * 还没做（等接真实上游时补）：webhook 重投去重（`externalMessageId` 链路已通，
 * 判重逻辑没写）、限流（网页那条走 entitlements，这里没有）、把回复真正发回
 * 小红书（现在只是同步返回，由调用方负责投递）。
 */
export async function POST(request: Request) {
  if (!checkToken(request)) {
    return jsonWithCors({ ok: false, error: "Unauthorized" }, 401);
  }

  let payload: Record<string, unknown>;
  try {
    payload = await request.json();
  } catch {
    return jsonWithCors({ ok: false, error: "Invalid JSON" }, 400);
  }

  const id = typeof payload.id === "string" ? payload.id.trim() : "";
  const text = typeof payload.text === "string" ? payload.text.trim() : "";

  if (!(id && text)) {
    return jsonWithCors({ ok: false, error: "id and text are required" }, 400);
  }

  try {
    const result = await handleInboundMessage({
      channel: "xhs",
      externalUserId: id,
      text,
    });

    const { text: reply, hits } = redactContactInfo(result.text);

    console.log(
      "[xhs/messages]",
      JSON.stringify({
        id,
        chatId: result.chatId,
        toolsUsed: result.toolsUsed,
        redacted: hits,
        chars: reply.length,
        elapsedMs: result.elapsedMs,
      })
    );

    return jsonWithCors({
      ok: true,
      id,
      chatId: result.chatId,
      reply,
      elapsedMs: result.elapsedMs,
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
