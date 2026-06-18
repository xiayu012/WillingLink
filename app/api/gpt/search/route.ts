/**
 * POST /api/gpt/search
 *
 * Semantic + structured rental listing search for Custom GPT Actions.
 * Authentication: Authorization: Bearer <WILLINGLINK_GPT_API_KEY>
 */
import "server-only";

import { requireGptKey } from "@/lib/api/gpt-auth";
import { embedText } from "@/lib/ai/embeddings";
import { vectorSearchXhsRentalListings } from "@/lib/db/queries";
import type { XhsRentalSearchResultRow } from "@/lib/db/queries";

const VECTOR_CANDIDATE_LIMIT = 60;
const DEFAULT_RESULT_LIMIT = 5;
const MAX_RESULT_LIMIT = 10;
const RAW_TEXT_EXCERPT_CHARS = 300;

type SearchRequest = {
  query: string;
  city?: string | null;
  rentMin?: number | null;
  rentMax?: number | null;
  bedroomsNum?: number | null;
  petFriendly?: boolean | null;
  couplesOk?: boolean | null;
  utilitiesIncluded?: boolean | null;
  parkingIncluded?: boolean | null;
  furnished?: string | null;
  limit?: number | null;
};

function toListingSummary(row: XhsRentalSearchResultRow) {
  return {
    id: row.id,
    sourceUrl: row.sourceUrl,
    title: row.title,
    rent: row.rent,
    rentNumeric: row.rentNumeric,
    deposit: row.deposit,
    city: row.city,
    locationText: row.locationText,
    propertyName: row.propertyName,
    bedrooms: row.bedrooms,
    bedroomsNum: row.bedroomsNum,
    bathrooms: row.bathrooms,
    roomType: row.roomType,
    listingType: row.listingType,
    furnished: row.furnished,
    availableFrom: row.availableFrom,
    leaseEndDate: row.leaseEndDate,
    contactMethod: row.contactMethod,
    petFriendly: row.petFriendly,
    couplesOk: row.couplesOk,
    utilitiesIncluded: row.utilitiesIncluded,
    parkingIncluded: row.parkingIncluded,
    imageUrls: row.imageUrls,
    createdAt: row.createdAt,
    rawTextExcerpt: row.rawText.slice(0, RAW_TEXT_EXCERPT_CHARS),
  };
}

function applyFilters(
  rows: XhsRentalSearchResultRow[],
  filters: Omit<SearchRequest, "query" | "limit">
): XhsRentalSearchResultRow[] {
  return rows.filter((row) => {
    if (
      filters.city != null &&
      row.city?.toLowerCase() !== filters.city.toLowerCase()
    ) {
      return false;
    }
    if (filters.rentMin != null) {
      if (row.rentNumeric == null || row.rentNumeric < filters.rentMin) {
        return false;
      }
    }
    if (filters.rentMax != null) {
      if (row.rentNumeric == null || row.rentNumeric > filters.rentMax) {
        return false;
      }
    }
    if (filters.bedroomsNum != null) {
      if (row.bedroomsNum == null || row.bedroomsNum !== filters.bedroomsNum) {
        return false;
      }
    }
    if (filters.petFriendly === true && row.petFriendly !== true) {
      return false;
    }
    if (filters.petFriendly === false && row.petFriendly === true) {
      return false;
    }
    if (filters.couplesOk === true && row.couplesOk !== true) {
      return false;
    }
    if (filters.utilitiesIncluded === true && row.utilitiesIncluded !== true) {
      return false;
    }
    if (filters.parkingIncluded === true && row.parkingIncluded !== true) {
      return false;
    }
    if (
      filters.furnished != null &&
      row.furnished?.toLowerCase() !== filters.furnished.toLowerCase()
    ) {
      return false;
    }
    return true;
  });
}

export async function OPTIONS() {
  return new Response(null, { status: 204 });
}

export async function POST(request: Request) {
  const denied = requireGptKey(request);
  if (denied) return denied;

  let body: SearchRequest;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { query, limit: rawLimit, ...filters } = body;

  if (typeof query !== "string" || query.trim().length === 0) {
    return Response.json(
      { error: "query is required and must be a non-empty string" },
      { status: 400 }
    );
  }

  const limit = Math.min(
    Math.max(1, typeof rawLimit === "number" ? rawLimit : DEFAULT_RESULT_LIMIT),
    MAX_RESULT_LIMIT
  );

  try {
    const embedding = await embedText(query.trim(), "query");
    const candidates = await vectorSearchXhsRentalListings(
      embedding,
      VECTOR_CANDIDATE_LIMIT
    );

    const filtered = applyFilters(candidates, filters);
    const results = filtered.slice(0, limit);

    return Response.json({
      listings: results.map(toListingSummary),
      count: results.length,
      totalBeforeFilter: candidates.length,
      totalAfterFilter: filtered.length,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[gpt/search] error:", msg);
    return Response.json({ error: "Search failed", detail: msg }, { status: 500 });
  }
}
