import { after } from "next/server";
import {
  checkToken,
  handleInboundMessage,
  jsonWithCors,
} from "@/lib/chat/adapter";
import { deliverToJijyun } from "@/lib/chat/jijyun";
import { redactContactInfo } from "@/lib/chat/redact-contact";
import {
  formatForDm,
  wantsContactCollection,
  XHS_DM_EXTRA_SYSTEM,
  XHS_DM_MODEL,
} from "@/lib/chat/xhs-dm";

// 60 秒撞过墙：2026-08-20 23:19 一次真实请求被 Vercel 硬杀（Task timed out after
// 60 seconds），函数连"投递失败"的兜底日志都没来得及写，表现就是用户收不到任何
// 回复。Pro 套餐单函数上限 300 秒，这里留够余量给"多步工具调用 + 一次慢响应"
// 叠加的情况，而不是指望每次都卡在 60 秒内。
export const maxDuration = 120;
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
 * 小红书私信 adapter —— **两次单向消息**，不是一问一答。
 *
 *   集简云 --POST {id,text}--> 这里     （立刻 202，不带任何正文）
 *   这里   --POST {id,text}--> 集简云 webhook  （想好了再发）
 *
 * 为什么拆开：集简云调我们只等 30 秒，而一轮带搜索的对话要 15-30 秒，同步返回
 * 必然压线。所以收到就应答，AI 的活儿交给 `after()` 在响应发出之后继续跑，算完
 * 再主动投递回去。
 *
 * `after()` 的活儿仍然算在这个函数的执行预算里（maxDuration=60），够用；它只是
 * 不再挡着响应。**注意**：在请求作用域之外调 `after()` 会抛（见 AGENT_LOG 里
 * 评测脚本那次事故），这里在 route handler 内，安全。
 *
 * 请求体只认两个字段：{ "id": "<小红书用户 id>", "text": "<对方说的话>" }
 * 身份 → 内部 user → 那个人**唯一**的一条 conversation → Chat Engine，所以同一个
 * id 再来接的是同一串上下文（评论区来过的人也是同一条会话）。
 *
 * 这一层唯一的渠道策略：**出站剔除联系方式**。存进 Message_v2 的仍是完整原文，
 * 网页上照常看得到，只有发出去的那份被剔。
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

  // 响应发出去之后才跑，所以集简云那 30 秒不会被 AI 拖住
  after(async () => {
    const startedAt = Date.now();
    try {
      const result = await handleInboundMessage({
        channel: "xhs",
        externalUserId: id,
        text,
        extraSystem: XHS_DM_EXTRA_SYSTEM,
        selectedChatModel: XHS_DM_MODEL,
      });

      // 判意图看**原文**：剔除那一层会按标点切碎重组，判完再剔才不会误伤
      const collectContact = wantsContactCollection(result.text);
      const { text: redacted, hits } = redactContactInfo(result.text);
      // 排版最后做：剔除会整行删字段、合并空行，先插分割线行结构会被它改掉
      const reply = formatForDm(redacted);

      console.log(
        "[xhs/messages]",
        JSON.stringify({
          id,
          chatId: result.chatId,
          toolsUsed: result.toolsUsed,
          redacted: hits,
          collectContact,
          chars: reply.length,
          elapsedMs: Date.now() - startedAt,
        })
      );

      await deliverToJijyun({
        id,
        text: reply,
        collectContact,
        chatId: result.chatId,
      });
    } catch (error) {
      // AI SDK 的错误对象别直接丢给 console.error（见 AGENT_LOG 的 fail-open 事故）
      const name = error instanceof Error ? error.name : "UnknownError";
      const message = error instanceof Error ? error.message : String(error);
      console.log("[xhs/messages] failed", `${name}: ${message}`);
      // 也要投递失败结果：不然集简云那头就一直等着，永远不知道这条黄了。
      // 这条没有正文，自然也谈不上收联系方式，collect_contact 走默认的 false。
      await deliverToJijyun({ id, text: "", ok: false, error: name });
    }
  });

  // 只是回执，不带正文——正文走上面那条出站消息
  return jsonWithCors({ ok: true, accepted: true, id }, 202);
}
