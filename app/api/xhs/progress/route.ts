const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders });
}

// 油猴脚本：信息流每点一次帖子标题就打一行日志，方便对比点击 vs 入库。
export async function POST(request: Request) {
  let body: { title?: unknown; version?: unknown } = {};
  try {
    body = await request.json();
  } catch {
    // 忽略非法 JSON
  }

  const title = typeof body.title === "string" ? body.title.trim() : "";
  const version = typeof body.version === "string" ? body.version : "?";
  const titleLabel = title || "(无标题)";

  console.log(`[小红书标题点击] ${titleLabel}（脚本 v${version}）`);

  return Response.json({ ok: true }, { headers: corsHeaders });
}
