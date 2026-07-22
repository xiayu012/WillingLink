import { classifyFeedTitles } from "@/lib/xhs/classify-feed-titles";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function jsonWithCors(body: unknown, status = 200) {
  return Response.json(body, { status, headers: corsHeaders });
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders });
}

export async function POST(request: Request) {
  let payload: Record<string, unknown>;
  try {
    payload = await request.json();
  } catch {
    return jsonWithCors({ ok: false, error: "Invalid JSON" }, 400);
  }

  const rawTitles = payload.titles;
  if (!Array.isArray(rawTitles)) {
    return jsonWithCors({ ok: false, error: "titles array is required" }, 400);
  }

  const titles = rawTitles
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .slice(0, 20);

  if (titles.length === 0) {
    return jsonWithCors({ ok: false, error: "titles must not be empty" }, 400);
  }

  const results = await classifyFeedTitles(titles);
  if (results.length === 0) {
    return jsonWithCors(
      {
        ok: false,
        error:
          "Title classification unavailable (火山方舟调用失败)",
      },
      503
    );
  }

  return jsonWithCors({ ok: true, results });
}
