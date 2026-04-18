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

function optString(v: unknown): string | null {
  if (typeof v !== "string") {
    return null;
  }
  const t = v.trim();
  return t.length > 0 ? t : null;
}

export async function POST(request: Request) {
  let payload: Record<string, unknown>;
  try {
    payload = await request.json();
  } catch {
    return jsonWithCors({ ok: false, error: "Invalid JSON" }, 400);
  }

  const sourceUrlRaw =
    optString(payload.sourceUrl) ?? optString(payload.pageUrl) ?? "";
  const rawText = optString(payload.rawText) ?? "";

  if (!sourceUrlRaw || !rawText) {
    return jsonWithCors(
      { ok: false, error: "sourceUrl (or pageUrl) and rawText are required" },
      400
    );
  }

  const row = await createXhsRentalListing({
    sourceUrl: sourceUrlRaw,
    rawText,
    title: optString(payload.title),
    rent: optString(payload.rent),
    deposit: optString(payload.deposit),
    availableFrom: optString(payload.availableFrom),
    leaseEndDate: optString(payload.leaseEndDate),
    listingType: optString(payload.listingType),
    bedrooms: optString(payload.bedrooms),
    bathrooms: optString(payload.bathrooms),
    roomType: optString(payload.roomType),
    propertyName: optString(payload.propertyName),
    locationText: optString(payload.locationText),
    furnished: optString(payload.furnished),
    contactMethod: optString(payload.contactMethod),
  });

  if (!row) {
    return jsonWithCors({ ok: false, error: "Failed to save" }, 500);
  }

  return jsonWithCors({ ok: true, id: row.id });
}
