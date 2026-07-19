import { randomUUID } from "crypto";

import { classifyRentalPostIntent } from "@/lib/ai/classify-rental-post";
import {
  createXhsRentalListing,
  createXhsRentalOther,
  createXhsRentalWanted,
} from "@/lib/db/queries";
import { classifyPost } from "@/lib/xhs/classify-post";
import {
  parseListingFields,
  parseWantedFields,
} from "@/lib/xhs/parse-rental-text";

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

  const rawText = optString(payload.rawText) ?? "";

  if (!rawText) {
    return jsonWithCors({ ok: false, error: "rawText is required" }, 400);
  }

  const sourceUrlRaw =
    optString(payload.sourceUrl) ??
    optString(payload.pageUrl) ??
    `pending:${randomUUID()}`;

  // Step 1: 先判断是否为非交易帖（经验/科普）
  const broadCategory = await classifyPost(rawText);

  if (broadCategory === "other") {
    // 真实写入 XhsRentalOther 表
    const inferredTitle =
      rawText.split(/[\n。！？!?]/)[0]?.slice(0, 80) ?? null;
    const row = await createXhsRentalOther({
      sourceUrl: sourceUrlRaw,
      rawText,
      title: optString(payload.title) ?? inferredTitle,
      aiReason: "经验/科普/非交易帖，由规则分类器识别",
    });

    if (!row) {
      return jsonWithCors(
        { ok: false, error: "Failed to save other post" },
        500
      );
    }

    return jsonWithCors({
      ok: true,
      id: row.id,
      duplicate: row.duplicate,
      sourceUrl: sourceUrlRaw,
      listingKind: "other",
      classification: {
        intent: "other",
        confidence: 1,
        reason: "经验/科普帖",
        source: "rule",
      },
    });
  }

  // Step 2: 对所有租房帖，使用 AI 全文阅读来区分招租 vs 求租
  // 不依赖关键词分类结果，避免误判
  const classification = await classifyRentalPostIntent(rawText);
  const isSeeker =
    classification.intent === "seeker" && classification.confidence >= 0.55;

  if (isSeeker) {
    const parsed = parseWantedFields(rawText);
    const row = await createXhsRentalWanted({
      sourceUrl: sourceUrlRaw,
      rawText,
      title: optString(payload.title) ?? parsed.title,
      budgetText: optString(payload.budgetText) ?? parsed.budgetText,
      preferredLocations:
        optString(payload.preferredLocations) ?? parsed.preferredLocations,
      moveInDate: optString(payload.moveInDate) ?? parsed.moveInDate,
      leaseDuration: optString(payload.leaseDuration) ?? parsed.leaseDuration,
      wantedType: optString(payload.wantedType) ?? parsed.wantedType,
      bedrooms: optString(payload.bedrooms) ?? parsed.bedrooms,
      bathrooms: optString(payload.bathrooms) ?? parsed.bathrooms,
      roomType: optString(payload.roomType) ?? parsed.roomType,
      furnished: optString(payload.furnished) ?? parsed.furnished,
      pets: optString(payload.pets) ?? parsed.pets,
      occupation: optString(payload.occupation) ?? parsed.occupation,
      householdSize: optString(payload.householdSize) ?? parsed.householdSize,
      gender: optString(payload.gender) ?? parsed.gender,
      requirements: optString(payload.requirements) ?? parsed.requirements,
      contactMethod: optString(payload.contactMethod) ?? parsed.contactMethod,
      aiConfidence: String(classification.confidence),
      aiReason: classification.reason,
    });

    if (!row) {
      return jsonWithCors(
        { ok: false, error: "Failed to save wanted post" },
        500
      );
    }

    return jsonWithCors({
      ok: true,
      id: row.id,
      duplicate: row.duplicate,
      sourceUrl: sourceUrlRaw,
      listingKind: "wanted",
      classification: {
        intent: classification.intent,
        confidence: classification.confidence,
        reason: classification.reason,
        source: classification.source,
      },
    });
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

  return jsonWithCors({
    ok: true,
    id: row.id,
    duplicate: row.duplicate,
    sourceUrl: sourceUrlRaw,
    listingKind: "listing",
    classification: {
      intent: classification.intent,
      confidence: classification.confidence,
      reason: classification.reason,
      source: classification.source,
    },
  });
}
