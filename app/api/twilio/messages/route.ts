import {
  adaptersEnabled,
  handleInboundMessage,
  jsonWithCors,
  toErrorResponse,
} from "@/lib/chat/adapter";

export const maxDuration = 60;
export const preferredRegion = "sfo1";

/**
 * Twilio 短信 adapter（骨架）。
 *
 * 已经能跑通"一条短信 → 同一条 conversation → 回答"，但**上线前必须补**：
 * 1. `X-Twilio-Signature` 验签（现在谁都能 POST 进来）
 * 2. 回复格式：这里先回 JSON，真接 Twilio 时要回 TwiML
 *    （`<Response><Message>…</Message></Response>`，Content-Type: text/xml）
 * 3. 长回复要按 1600 字符分段
 *
 * 结构上要看的只有一点：**adapter 只做字段翻译**，聊天逻辑一行都没有。
 */
export async function POST(request: Request) {
  if (!adaptersEnabled()) {
    return jsonWithCors(
      { ok: false, error: "Channel adapters disabled (set CHANNEL_ADAPTERS_ENABLED=1)" },
      503
    );
  }

  // Twilio 发的是 application/x-www-form-urlencoded
  const form = await request.formData().catch(() => null);
  const from = String(form?.get("From") ?? "").trim();
  const body = String(form?.get("Body") ?? "").trim();
  const messageSid = String(form?.get("MessageSid") ?? "").trim() || null;

  if (!(from && body)) {
    return jsonWithCors({ ok: false, error: "From and Body are required" }, 400);
  }

  try {
    const result = await handleInboundMessage({
      channel: "sms",
      externalUserId: from, // 手机号就是这个渠道里的身份
      text: body,
      externalMessageId: messageSid,
    });
    // TODO(twilio): 换成 TwiML
    return jsonWithCors({ ok: true, chatId: result.chatId, reply: result.text });
  } catch (error) {
    return toErrorResponse(error);
  }
}
