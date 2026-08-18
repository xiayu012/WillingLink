import {
  adaptersEnabled,
  handleInboundMessage,
  jsonWithCors,
  toErrorResponse,
} from "@/lib/chat/adapter";

export const maxDuration = 60;
export const preferredRegion = "sfo1";

/**
 * 企业微信 adapter（骨架）。
 *
 * 上线前必须补：
 * 1. URL 验证回调（GET + echostr，企业微信配置回调地址时会先打这个）
 * 2. 消息体是 **AES 加密的 XML**，要先解密再解析（msg_signature/timestamp/nonce）
 * 3. 被动回复有 5 秒限制，聊天要 10-20 秒 —— 实际要走"先回收到，再用客服消息
 *    接口异步推送答案"，也就是这里应该 202 收下、后台跑完再 push
 *
 * 现在先按已解密的 JSON 收，把链路形状摆出来。
 */
export async function POST(request: Request) {
  if (!adaptersEnabled()) {
    return jsonWithCors(
      { ok: false, error: "Channel adapters disabled (set CHANNEL_ADAPTERS_ENABLED=1)" },
      503
    );
  }

  let payload: Record<string, unknown>;
  try {
    payload = await request.json();
  } catch {
    return jsonWithCors({ ok: false, error: "Invalid JSON (expect decrypted body)" }, 400);
  }

  const externalUserId =
    typeof payload.external_userid === "string" ? payload.external_userid : "";
  const text = typeof payload.content === "string" ? payload.content.trim() : "";

  if (!(externalUserId && text)) {
    return jsonWithCors(
      { ok: false, error: "external_userid and content are required" },
      400
    );
  }

  try {
    const result = await handleInboundMessage({
      channel: "wecom",
      externalUserId,
      text,
      accountId: typeof payload.agentid === "string" ? payload.agentid : null,
      externalMessageId: typeof payload.msgid === "string" ? payload.msgid : null,
    });
    // TODO(wecom): 改成 202 + 客服消息接口异步推送（被动回复只有 5 秒）
    return jsonWithCors({ ok: true, chatId: result.chatId, reply: result.text });
  } catch (error) {
    return toErrorResponse(error);
  }
}
