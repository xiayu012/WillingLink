import { after } from "next/server";
import {
  adaptersEnabled,
  handleInboundMessage,
  jsonWithCors,
  toErrorResponse,
} from "@/lib/chat/adapter";
import { runColivingTurn } from "@/lib/chat/coliving/turn";
import { emptyTwiml, sendSms, verifyTwilioSignature } from "@/lib/chat/twilio";

// 与 /api/xhs/messages 同理：AI 那段跑在 after() 里，仍算在这个预算内。
// 60 秒撞过墙（见 AGENT_LOG），留够余量。
export const maxDuration = 120;
export const preferredRegion = "sfo1";

/**
 * Twilio 短信 —— **本项目唯一的 Twilio 入口**。
 *
 * 曾经短暂存在过 `/api/twilio/coliving`，已合并到这里，不要再开第二条。
 *
 * 两种大脑，由 `TWILIO_BRAIN` 选择：
 *
 * - `coliving`（默认）合租房管理。走 `lib/ai/brains` 的 coliving 大脑，
 *   **不依赖数据库**，会话与名册在内存/环境变量里。
 * - `rental` 租房搜索。走 `handleInboundMessage` → Chat Engine，
 *   跨渠道共用同一条 conversation，**需要 channel-identity 表**。
 *
 * 为什么不同步回 TwiML 正文：Twilio 对 webhook 只等约 15 秒，而一轮带
 * 1–2 万字符准则、可能还要调工具的对话会压线。所以**立刻回空 TwiML，
 * 回复走出站 API**——跟小红书那条踩过的是同一个坑。
 */
export async function POST(request: Request) {
  if (!adaptersEnabled()) {
    return new Response(
      "channel adapters disabled (set CHANNEL_ADAPTERS_ENABLED=1)",
      { status: 503 }
    );
  }

  const form = await request.formData().catch(() => null);
  if (!form) {
    return new Response("expected form-encoded body", { status: 400 });
  }

  const params: Record<string, string> = {};
  for (const [k, v] of form.entries()) {
    params[k] = typeof v === "string" ? v : "";
  }

  const verified = verifyTwilioSignature({
    request,
    params,
    signature: request.headers.get("x-twilio-signature"),
  });
  if (!verified.ok) {
    console.log("[twilio] 验签失败：", verified.reason);
    return new Response("signature verification failed", { status: 403 });
  }

  const from = (params.From ?? "").trim();
  const body = (params.Body ?? "").trim();
  const messageSid = (params.MessageSid ?? "").trim();

  // 送达回执等非消息回调也会打到这里，静默收下
  if (!(from && body)) {
    return emptyTwiml();
  }

  const brain = (process.env.TWILIO_BRAIN ?? "coliving").trim();

  if (brain === "rental") {
    // 老路径：DB 支撑的跨渠道会话。同步返回，因为它没有出站投递通道。
    try {
      const result = await handleInboundMessage({
        channel: "sms",
        externalUserId: from,
        text: body,
        externalMessageId: messageSid || null,
      });
      return jsonWithCors({ ok: true, chatId: result.chatId, reply: result.text });
    } catch (error) {
      return toErrorResponse(error);
    }
  }

  after(async () => {
    try {
      const outcome = await runColivingTurn({ fromPhone: from, text: body });

      if (outcome.reply) {
        const sent = await sendSms(from, outcome.reply);
        if (!sent.ok) {
          console.log("[twilio] 回复发送失败：", sent.error);
        }
      }

      // 转交给管理方的短信
      for (const msg of outcome.outbound) {
        const sent = await sendSms(msg.to, msg.text);
        if (!sent.ok) {
          console.log("[twilio] 转交发送失败：", sent.error);
        }
      }

      console.log(
        "[twilio]",
        JSON.stringify({
          messageSid,
          modules: outcome.modules,
          tools: outcome.toolsUsed,
          promptChars: outcome.promptChars,
          replyChars: outcome.reply.length,
          notified: outcome.outbound.length,
        })
      );
    } catch (error) {
      const name = error instanceof Error ? error.name : "UnknownError";
      const message = error instanceof Error ? error.message : String(error);
      // AI SDK 的错误对象别直接丢 console.error（见 AGENT_LOG 的 fail-open 事故）
      console.log("[twilio] failed", `${name}: ${message}`);
    }
  });

  return emptyTwiml();
}
