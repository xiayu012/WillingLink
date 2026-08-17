import {
  classifyRentalPostIntent,
  type RentalPostIntent,
} from "@/lib/ai/classify-rental-post";
import { getFeedTitleModel } from "@/lib/ai/providers";

export const preferredRegion = "sfo1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Xhs-Token",
};

function jsonWithCors(body: unknown, status = 200) {
  return Response.json(body, { status, headers: corsHeaders });
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders });
}

/**
 * 便宜的岔路口：这条帖子是不是「租客在求租」。
 *
 * 油猴复制正文后先问这里，只有 seeker 才继续走 /api/xhs/comment-reply
 * ——那条路由每次要跑一整轮带搜索的 agent，而信息流里绝大多数帖子是招租帖或
 * 经验帖，先花这一次便宜调用挡掉，省下的是大头。
 *
 * 复用入库那套 `classifyRentalPostIntent`：它先跑正则快路径（多数帖子**一次
 * 模型都不用调**），命中不够确信才落到 LLM，这里把模型换成全项目最便宜的
 * gpt-4o-mini（`getFeedTitleModel`，信息流标题判定同款）。
 */
export async function POST(request: Request) {
  const expectedToken = process.env.XHS_API_TOKEN?.trim();
  if (expectedToken && request.headers.get("x-xhs-token") !== expectedToken) {
    return jsonWithCors({ ok: false, error: "Unauthorized" }, 401);
  }

  let payload: Record<string, unknown>;
  try {
    payload = await request.json();
  } catch {
    return jsonWithCors({ ok: false, error: "Invalid JSON" }, 400);
  }

  const rawText =
    typeof payload.rawText === "string" ? payload.rawText.trim() : "";
  if (!rawText) {
    return jsonWithCors({ ok: false, error: "rawText is required" }, 400);
  }

  const startedAt = Date.now();
  try {
    const classification = await classifyRentalPostIntent(rawText, {
      model: getFeedTitleModel(),
    });
    const intent: RentalPostIntent = classification.intent;

    console.log(
      "[post-intent]",
      JSON.stringify({
        intent,
        confidence: classification.confidence,
        source: classification.source,
        elapsedMs: Date.now() - startedAt,
        preview: rawText.slice(0, 60),
      })
    );

    return jsonWithCors({
      ok: true,
      intent,
      isSeeker: intent === "seeker",
      confidence: classification.confidence,
      reason: classification.reason,
      source: classification.source,
      elapsedMs: Date.now() - startedAt,
    });
  } catch (error) {
    // AI SDK 的错误对象不能直接丢给 console.error（见 AGENT_LOG 的 fail-open 事故）
    const name = error instanceof Error ? error.name : "UnknownError";
    console.log("[post-intent] failed", name);
    return jsonWithCors({ ok: false, error: `Classify failed: ${name}` }, 502);
  }
}
