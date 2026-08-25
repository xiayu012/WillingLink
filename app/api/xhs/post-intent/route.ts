import { classifyPostKind } from "@/lib/xhs/post-kind";
import { shouldDraftComment } from "@/lib/xhs/post-kind-rules";

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
 * 便宜的岔路口：这条帖子值不值得去评论。
 *
 * 油猴复制正文后先问这里，只有该评论的类别才继续走 /api/xhs/comment-reply
 * ——那条路由每次要跑一整轮带搜索的 agent，先花这一次便宜调用挡掉，省的是大头。
 *
 * **分六类不是三类**（`lib/xhs/post-kind.ts`）：以前只分 seeker/其它，看房体验帖
 * 里全是租房关键词，被当成求租帖，评论区就答非所问（AGENT_LOG 2026-08-25 Case F）。
 * 现在 review/advice/other 明确挡在门外。
 *
 * 兼容：`isSeeker` 字段保留，老版本油猴还在读它——现在的语义是"该不该评论"，
 * seeker/lister/roommate 都算 true。
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
    const result = await classifyPostKind(rawText);
    const actionable = shouldDraftComment(result.kind);

    console.log(
      "[post-intent]",
      JSON.stringify({
        kind: result.kind,
        actionable,
        confidence: result.confidence,
        source: result.source,
        elapsedMs: Date.now() - startedAt,
        preview: rawText.slice(0, 60),
      })
    );

    return jsonWithCors({
      ok: true,
      kind: result.kind,
      actionable,
      // 老版本油猴读的是 intent/isSeeker，保持能用
      intent: result.kind,
      isSeeker: actionable,
      confidence: result.confidence,
      reason: result.reason,
      source: result.source,
      elapsedMs: Date.now() - startedAt,
    });
  } catch (error) {
    // AI SDK 的错误对象不能直接丢给 console.error（见 AGENT_LOG 的 fail-open 事故）
    const name = error instanceof Error ? error.name : "UnknownError";
    console.log("[post-intent] failed", name);
    return jsonWithCors({ ok: false, error: `Classify failed: ${name}` }, 502);
  }
}
