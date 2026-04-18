import { createXhsRentalListing } from "@/lib/db/queries";

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
  let payload: { pageUrl?: string; rawText?: string };
  try {
    payload = await request.json();
  } catch {
    return jsonWithCors({ ok: false, error: "Invalid JSON" }, 400);
  }

  const pageUrl =
    typeof payload.pageUrl === "string" ? payload.pageUrl.trim() : "";
  const rawText =
    typeof payload.rawText === "string" ? payload.rawText.trim() : "";

  if (!pageUrl || !rawText) {
    return jsonWithCors(
      { ok: false, error: "pageUrl and rawText are required" },
      400
    );
  }

  const row = await createXhsRentalListing({ pageUrl, rawText });
  if (!row) {
    return jsonWithCors({ ok: false, error: "Failed to save" }, 500);
  }

  return jsonWithCors({ ok: true, id: row.id });
}
