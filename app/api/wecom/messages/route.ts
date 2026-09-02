import { after } from "next/server";
import { adaptersEnabled, handleInboundMessage } from "@/lib/chat/adapter";
import { markCommunication } from "@/lib/chat/coliving/repo";
import { runColivingTurn } from "@/lib/chat/coliving/turn";
import {
  decryptWecom,
  sendWecomText,
  verifyWecomSignature,
  wecomConfig,
  xmlValue,
} from "@/lib/chat/wecom";

// 与 Twilio 那条同理：AI 那段跑在 after() 里，仍算在这个预算内
export const maxDuration = 300;
export const preferredRegion = "sfo1";

/**
 * 企业微信 —— **本项目唯一的企业微信入口**。
 *
 * 回调地址填这个：`https://www.willinglink.com/api/wecom/messages`
 * （注意用 www，裸域 308 跳转会让验签失败 —— 见 lib/chat/TWILIO.md 那一节，
 * 企业微信签名同样是按原始 URL 之外的参数算的，但跳转会丢 body，一样跑不通）
 *
 * 两个方法各管一件事：
 *   GET  在后台「设置API接收」点保存时被调用一次，**必须解密 echostr 回明文**，
 *        否则不让保存。
 *   POST 真实消息。被动回复只有 5 秒，所以立刻回空串，答案走应用消息接口推送。
 *
 * ⚠️ **上线顺序不能反**：后台「设置API接收」点保存时，企业微信会**当场**
 *    打一次 GET 验证回调地址。所以必须先把这个路由部署上去、环境变量配好，
 *    才能去点保存 —— 反过来做一定失败，而且它只说「回调地址验证失败」，
 *    不告诉你是签名错了还是解密错了。本地先跑 `pnpm wecom:selftest`。
 *
 * 两种大脑，由 `WECOM_BRAIN` 选择（与 Twilio 那条对称）：
 *   `coliving`（默认）合租房管理，事实落在 coliving schema
 *   `rental`            租房搜索，走 handleInboundMessage，需要 channel-identity 表
 *
 * 认人靠 `coliving.person_contact` 里 kind='wecom' 的那条，值是企业微信 UserID
 * （从微信加入的成员，userid 会是 wxid_ 开头）。认不出就只回一句问对方是谁，
 * **不落任何记录** —— 否则任何人都能往事实账本里塞东西。
 */

/** 改了这个路由就顺手 +1，用来从外面确认生产环境跑的是哪一版 */
const BUILD_MARKER = "2026-09-01-coliving";

function textResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

/** 回调地址校验：企业微信配置回调时先打这个 */
export async function GET(request: Request) {
  const config = wecomConfig();
  if (!config) {
    return Response.json(
      { ok: false, endpoint: "wecom", configured: false, build: BUILD_MARKER },
      { status: 503 }
    );
  }
  const url = new URL(request.url);
  const echostr = url.searchParams.get("echostr") ?? "";
  if (!echostr) {
    // 不带 echostr 的裸 GET = 健康检查。只回布尔和大脑名，不泄漏任何密钥。
    // 存在的理由：出问题时最难回答的是「生产环境到底跑的哪一版、配全了没」，
    // 从外面看这一切都是不可见的。
    return Response.json({
      ok: true,
      endpoint: "wecom",
      brain: process.env.WECOM_BRAIN ?? "coliving",
      configured: true,
      adaptersEnabled: adaptersEnabled(),
      agentId: config.agentId,
      build: BUILD_MARKER,
    });
  }

  const ok = verifyWecomSignature({
    config,
    msgSignature: url.searchParams.get("msg_signature"),
    timestamp: url.searchParams.get("timestamp"),
    nonce: url.searchParams.get("nonce"),
    encrypt: echostr,
  });
  if (!ok) {
    console.log("[wecom] 回调校验：验签失败");
    return textResponse("signature mismatch", 403);
  }

  try {
    // 必须回**解密后的明文**，不是 echostr 原文
    return textResponse(decryptWecom(config, echostr));
  } catch (error) {
    console.log(
      "[wecom] 回调校验：解密失败",
      error instanceof Error ? error.message : String(error)
    );
    return textResponse("decrypt failed", 403);
  }
}

export async function POST(request: Request) {
  if (!adaptersEnabled()) {
    return textResponse("channel adapters disabled", 503);
  }
  const config = wecomConfig();
  if (!config) {
    return textResponse("wecom not configured", 503);
  }

  const url = new URL(request.url);
  const body = await request.text();
  const encrypt = xmlValue(body, "Encrypt");
  if (!encrypt) {
    return textResponse("missing Encrypt", 400);
  }

  const ok = verifyWecomSignature({
    config,
    msgSignature: url.searchParams.get("msg_signature"),
    timestamp: url.searchParams.get("timestamp"),
    nonce: url.searchParams.get("nonce"),
    encrypt,
  });
  if (!ok) {
    console.log("[wecom] 验签失败");
    return textResponse("signature mismatch", 403);
  }

  let xml: string;
  try {
    xml = decryptWecom(config, encrypt);
  } catch (error) {
    console.log(
      "[wecom] 解密失败",
      error instanceof Error ? error.message : String(error)
    );
    return textResponse("decrypt failed", 403);
  }

  const fromUser = xmlValue(xml, "FromUserName");
  const msgType = xmlValue(xml, "MsgType");
  const content = xmlValue(xml, "Content").trim();
  const msgId = xmlValue(xml, "MsgId");

  // 关注/取关等事件、图片语音等，先静默收下，不当错误
  if (msgType !== "text" || !(fromUser && content)) {
    console.log("[wecom] 收到非文本或空消息：", msgType);
    return textResponse("");
  }

  const brain = (process.env.WECOM_BRAIN ?? "coliving").trim();

  after(async () => {
    try {
      if (brain === "rental") {
        const result = await handleInboundMessage({
          channel: "wecom",
          externalUserId: fromUser,
          text: content,
          accountId: config.agentId,
          externalMessageId: msgId || null,
        });
        if (result.text) {
          await sendWecomText({ config, toUser: fromUser, text: result.text });
        }
        console.log("[wecom]", JSON.stringify({ msgId, chatId: result.chatId }));
        return;
      }

      const outcome = await runColivingTurn({
        channel: "wecom",
        from: fromUser,
        text: content,
      });

      // communication 先落库成 queued，发完回写——发送结果也是事实账本的一部分
      const deliver = async (
        toUser: string,
        text: string,
        communicationId: string | null
      ) => {
        const sent = await sendWecomText({ config, toUser, text });
        if (communicationId) {
          await markCommunication({
            communicationId,
            status: sent.ok ? "sent" : "failed",
            error: sent.ok ? null : (sent.error ?? "unknown"),
          });
        }
        if (!sent.ok) {
          console.log("[wecom] 推送失败：", sent.error);
        }
      };

      if (outcome.reply) {
        await deliver(fromUser, outcome.reply, outcome.replyCommunicationId);
      }
      // 主动发给房子里其他人的（杠杆二）；他们得也有 wecom 地址才收得到
      for (const m of outcome.outbound) {
        await deliver(m.to, m.text, m.communicationId);
      }

      console.log(
        "[wecom]",
        JSON.stringify({
          msgId,
          from: fromUser,
          unknownSender: outcome.unknownSender,
          tools: outcome.toolsUsed,
          replyChars: outcome.reply.length,
          outbound: outcome.outbound.length,
          usage: outcome.usage,
        })
      );
    } catch (error) {
      const name = error instanceof Error ? error.name : "UnknownError";
      const message = error instanceof Error ? error.message : String(error);
      // AI SDK 的错误对象别直接丢 console.error（见 AGENT_LOG 的 fail-open 事故）
      console.log("[wecom] failed", `${name}: ${message}`);
    }
  });

  // 被动回复只有 5 秒，回空串表示「不用被动回复」，答案已经走推送了
  return textResponse("");
}
