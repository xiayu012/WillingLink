import { createXhsRentalListing } from "@/lib/db/xhs-queries";

const RENT_RE =
  /(?:租金|房租|rent|price|价格|月租)[^\n$¥￥\d]{0,12}([$¥￥]?\s?\d[\d,]*(?:\.\d+)?\s?(?:刀|美金|usd|\/月|per month|monthly|month|mo)?)/i;
const DEPOSIT_RE =
  /(?:押金|deposit)[^\n$¥￥\d]{0,12}([$¥￥]?\s?\d[\d,]*(?:\.\d+)?\s?(?:刀|美金|usd|个月|month|mo)?)/i;
const BED_BATH_RE =
  /(\d+(?:\.\d+)?)\s*(?:b|室|bed|br|bedroom)s?\s*(\d+(?:\.\d+)?)?\s*(?:b|卫|bath|ba|bathroom)s?/i;
const BEDROOM_RE = /(\d+(?:\.\d+)?)\s*(?:b|室|bed|br|bedroom)s?/i;
const BATHROOM_RE = /(\d+(?:\.\d+)?)\s*(?:卫|bath|ba|bathroom)s?/i;
const AVAILABLE_RE =
  /(?:入住|available|avail|起租|可入住|入住时间)[^\n\d]{0,12}((?:\d{1,2}[/.-]\d{1,2}(?:[/.-]\d{2,4})?)|(?:\d{4}[/.-]\d{1,2}[/.-]\d{1,2})|(?:now|asap|immediate|随时))/i;
const LEASE_END_RE =
  /(?:lease\s*end|租期到|到期|租期至|end date)[^\n\d]{0,12}((?:\d{1,2}[/.-]\d{1,2}(?:[/.-]\d{2,4})?)|(?:\d{4}[/.-]\d{1,2}[/.-]\d{1,2}))/i;
const CONTACT_RE =
  /((?:微信|wechat|vx|v信)[:：\s]*[a-zA-Z0-9_-]{3,})|([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})|((?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}))/i;
const PROPERTY_RE =
  /(?:公寓|小区|apartment|apt|community|property|楼盘)[:：\s]*([^\n，,。;；]{2,60})/i;
const LINE_SPLIT_RE = /\n+/;
const SPACE_RUN_RE = /\s+/g;

const BAY_AREA_LOCATIONS = [
  "San Francisco",
  "San Jose",
  "Oakland",
  "Palo Alto",
  "Fremont",
  "Santa Clara",
  "Mountain View",
  "Sunnyvale",
  "Berkeley",
  "Daly City",
  "Cupertino",
  "Milpitas",
  "Redwood City",
  "San Mateo",
  "湾区",
  "旧金山",
  "圣何塞",
  "奥克兰",
  "伯克利",
] as const;

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

function matchText(re: RegExp, text: string, group = 1): string | null {
  const m = text.match(re);
  const value = m?.[group]?.trim();
  return value && value.length > 0 ? value : null;
}

function inferTitle(text: string): string | null {
  const lines = text
    .split(LINE_SPLIT_RE)
    .map((line) => line.replace(SPACE_RUN_RE, " ").trim())
    .filter((line) => line.length > 0);
  const title = lines.find((line) => line.length >= 4 && line.length <= 120);
  return title ?? null;
}

function inferLocation(text: string): string | null {
  const hits = BAY_AREA_LOCATIONS.filter((name) =>
    text.toLowerCase().includes(name.toLowerCase())
  );
  return hits.length > 0 ? hits.join(", ") : null;
}

function inferListingType(text: string): string | null {
  const lower = text.toLowerCase();
  if (lower.includes("转租") || lower.includes("sublease")) {
    return "sublease";
  }
  if (lower.includes("找室友") || lower.includes("roommate")) {
    return "roommate";
  }
  if (lower.includes("求租")) {
    return "wanted";
  }
  if (
    lower.includes("出租") ||
    lower.includes("lease") ||
    lower.includes("rent")
  ) {
    return "rent";
  }
  return null;
}

function inferRoomType(text: string): string | null {
  const lower = text.toLowerCase();
  if (lower.includes("主卧") || lower.includes("master")) {
    return "master bedroom";
  }
  if (lower.includes("次卧") || lower.includes("客卧")) {
    return "bedroom";
  }
  if (lower.includes("studio")) {
    return "studio";
  }
  if (lower.includes("客厅") || lower.includes("living room")) {
    return "living room";
  }
  return null;
}

function inferFurnished(text: string): string | null {
  const lower = text.toLowerCase();
  if (lower.includes("不带家具") || lower.includes("unfurnished")) {
    return "unfurnished";
  }
  if (lower.includes("家具") || lower.includes("furnished")) {
    return "furnished";
  }
  return null;
}

function extractBedroomsBathrooms(text: string) {
  const both = text.match(BED_BATH_RE);
  if (both?.[1]) {
    return {
      bedrooms: both[1],
      bathrooms: both[2] ?? null,
    };
  }
  return {
    bedrooms: matchText(BEDROOM_RE, text),
    bathrooms: matchText(BATHROOM_RE, text),
  };
}

function parseListingFields(rawText: string) {
  const { bedrooms, bathrooms } = extractBedroomsBathrooms(rawText);
  return {
    title: inferTitle(rawText),
    rent: matchText(RENT_RE, rawText),
    deposit: matchText(DEPOSIT_RE, rawText),
    availableFrom: matchText(AVAILABLE_RE, rawText),
    leaseEndDate: matchText(LEASE_END_RE, rawText),
    listingType: inferListingType(rawText),
    bedrooms,
    bathrooms,
    roomType: inferRoomType(rawText),
    propertyName: matchText(PROPERTY_RE, rawText),
    locationText: inferLocation(rawText),
    furnished: inferFurnished(rawText),
    contactMethod: matchText(CONTACT_RE, rawText, 0),
  };
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

  const parsed = parseListingFields(rawText);
  const row = await createXhsRentalListing({
    sourceUrl: sourceUrlRaw,
    rawText,
    title: optString(payload.title) ?? parsed.title,
    rent: optString(payload.rent) ?? parsed.rent,
    deposit: optString(payload.deposit) ?? parsed.deposit,
    availableFrom: optString(payload.availableFrom) ?? parsed.availableFrom,
    leaseEndDate: optString(payload.leaseEndDate) ?? parsed.leaseEndDate,
    listingType: optString(payload.listingType) ?? parsed.listingType,
    bedrooms: optString(payload.bedrooms) ?? parsed.bedrooms,
    bathrooms: optString(payload.bathrooms) ?? parsed.bathrooms,
    roomType: optString(payload.roomType) ?? parsed.roomType,
    propertyName: optString(payload.propertyName) ?? parsed.propertyName,
    locationText: optString(payload.locationText) ?? parsed.locationText,
    furnished: optString(payload.furnished) ?? parsed.furnished,
    contactMethod: optString(payload.contactMethod) ?? parsed.contactMethod,
  });

  if (!row) {
    return jsonWithCors({ ok: false, error: "Failed to save" }, 500);
  }

  return jsonWithCors({ ok: true, id: row.id });
}
