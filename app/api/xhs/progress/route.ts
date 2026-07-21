const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders });
}

// 很简陋：油猴脚本低频上报当天累计数，这里只打一行中文日志，方便在 Vercel runtime log 里看进度。
export async function POST(request: Request) {
  let body: { day?: unknown; count?: unknown; reason?: unknown; version?: unknown } = {};
  try {
    body = await request.json();
  } catch {
    // 忽略非法 JSON
  }

  const day = typeof body.day === "string" ? body.day : "未知日期";
  const count = Number(body.count) || 0;
  const reason = typeof body.reason === "string" ? body.reason : "未知";
  const version = typeof body.version === "string" ? body.version : "?";

  console.log(
    `[小红书今日进度] ${day} 已采集 ${count} 条（触发: ${reason}, 脚本 v${version}）`
  );

  return Response.json({ ok: true }, { headers: corsHeaders });
}
