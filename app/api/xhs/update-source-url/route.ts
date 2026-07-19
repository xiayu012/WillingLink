import {
  resolveXhsRecordKind,
  updateXhsRecordSourceUrl,
  type XhsRecordKind,
} from "@/lib/db/queries";

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

function optString(v: unknown): string | null {
  if (typeof v !== "string") {
    return null;
  }
  const t = v.trim();
  return t.length > 0 ? t : null;
}

function isValidXhsShareUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    return (
      host.includes("xiaohongshu.com") ||
      host.includes("xhslink.com") ||
      host.includes("xhs.cn")
    );
  } catch {
    return false;
  }
}

export async function POST(request: Request) {
  let payload: Record<string, unknown>;
  try {
    payload = await request.json();
  } catch {
    return jsonWithCors({ ok: false, error: "Invalid JSON" }, 400);
  }

  const listingId = optString(payload.listingId) ?? "";
  const sourceUrl = optString(payload.sourceUrl) ?? "";
  const listingKindRaw = optString(payload.listingKind);
  const listingKind: XhsRecordKind | null =
    listingKindRaw === "wanted" ||
    listingKindRaw === "listing" ||
    listingKindRaw === "other"
      ? listingKindRaw
      : null;

  if (!listingId || !sourceUrl) {
    return jsonWithCors(
      { ok: false, error: "listingId and sourceUrl are required" },
      400
    );
  }

  if (!isValidXhsShareUrl(sourceUrl)) {
    return jsonWithCors(
      { ok: false, error: "sourceUrl must be a Xiaohongshu share link" },
      400
    );
  }

  const row = await updateXhsRecordSourceUrl(listingId, sourceUrl, listingKind);
  if (!row) {
    return jsonWithCors({ ok: false, error: "Listing not found" }, 404);
  }

  if (
    !row.sourceUrl ||
    row.sourceUrl.startsWith("pending:") ||
    !isValidXhsShareUrl(row.sourceUrl)
  ) {
    return jsonWithCors(
      { ok: false, error: "Update did not persist a valid share URL" },
      500
    );
  }

  const resolvedKind =
    (await resolveXhsRecordKind(row.id)) ?? listingKind ?? "listing";
  return jsonWithCors({
    ok: true,
    id: row.id,
    duplicate: row.duplicate,
    sourceUrl: row.sourceUrl,
    listingKind: resolvedKind,
  });
}
