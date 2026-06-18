/**
 * POST /api/gpt/search
 *
 * Semantic + structured rental listing search for Custom GPT Actions.
 * Authentication: Authorization: Bearer <WILLINGLINK_GPT_API_KEY>
 */
import "server-only";

import postgres from "postgres";
import { requireGptKey } from "@/lib/api/gpt-auth";
import { embedText } from "@/lib/ai/embeddings";
import { vectorSearchXhsRentalListings } from "@/lib/db/queries";
import type { XhsRentalSearchResultRow } from "@/lib/db/queries";

const VECTOR_CANDIDATE_LIMIT = 60;
const SQL_FALLBACK_LIMIT = 100;
const DEFAULT_RESULT_LIMIT = 5;
const MAX_RESULT_LIMIT = 10;
const RAW_TEXT_EXCERPT_CHARS = 300;

// biome-ignore lint/style/noNonNullAssertion: required env var
const client = postgres(process.env.POSTGRES_URL!);

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
  mustNotContain?: string[] | null;
  excludeIds?: string[] | null;
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
  filters: Omit<SearchRequest, "query" | "limit" | "excludeIds">
): XhsRentalSearchResultRow[] {
  const blockedTerms = (filters.mustNotContain ?? [])
    .map((term) => term.trim().toLowerCase())
    .filter((term) => term.length > 0);

  return rows.filter((row) => {
    if (blockedTerms.length > 0) {
      const searchableText = [
        row.title,
        row.rawText,
        row.locationText,
        row.propertyName,
      ]
        .filter((value): value is string => typeof value === "string")
        .join("\n")
        .toLowerCase();

      if (blockedTerms.some((term) => searchableText.includes(term))) {
        return false;
      }
    }

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

async function getSqlFallbackCandidates(
  excludeIds: string[] = []
): Promise<XhsRentalSearchResultRow[]> {
  const rows =
    excludeIds.length > 0
      ? await client`
          SELECT
            id, "sourceUrl", title, "rawText",
            rent, "rentNumeric", deposit,
            "availableFrom", "leaseEndDate",
            "listingType", bedrooms, "bedroomsNum", bathrooms, "roomType",
            "propertyName", "locationText", city,
            furnished, "contactMethod",
            "petFriendly", "couplesOk", "utilitiesIncluded", "parkingIncluded",
            "imageUrls", "createdAt"
          FROM "XhsRentalListing"
          WHERE id != ALL(${excludeIds}::uuid[])
          ORDER BY "createdAt" DESC
          LIMIT ${SQL_FALLBACK_LIMIT}
        `
      : await client`
          SELECT
            id, "sourceUrl", title, "rawText",
            rent, "rentNumeric", deposit,
            "availableFrom", "leaseEndDate",
            "listingType", bedrooms, "bedroomsNum", bathrooms, "roomType",
            "propertyName", "locationText", city,
            furnished, "contactMethod",
            "petFriendly", "couplesOk", "utilitiesIncluded", "parkingIncluded",
            "imageUrls", "createdAt"
          FROM "XhsRentalListing"
          ORDER BY "createdAt" DESC
          LIMIT ${SQL_FALLBACK_LIMIT}
        `;

  return rows.map((row) => ({
    id: row.id as string,
    sourceUrl: row.sourceUrl as string,
    title: (row.title as string | null) ?? null,
    rawText: row.rawText as string,
    rent: (row.rent as string | null) ?? null,
    rentNumeric: (row.rentNumeric as number | null) ?? null,
    deposit: (row.deposit as string | null) ?? null,
    availableFrom: (row.availableFrom as string | null) ?? null,
    leaseEndDate: (row.leaseEndDate as string | null) ?? null,
    listingType: (row.listingType as string | null) ?? null,
    bedrooms: (row.bedrooms as string | null) ?? null,
    bedroomsNum: (row.bedroomsNum as number | null) ?? null,
    bathrooms: (row.bathrooms as string | null) ?? null,
    roomType: (row.roomType as string | null) ?? null,
    propertyName: (row.propertyName as string | null) ?? null,
    locationText: (row.locationText as string | null) ?? null,
    city: (row.city as string | null) ?? null,
    furnished: (row.furnished as string | null) ?? null,
    contactMethod: (row.contactMethod as string | null) ?? null,
    petFriendly: (row.petFriendly as boolean | null) ?? null,
    couplesOk: (row.couplesOk as boolean | null) ?? null,
    utilitiesIncluded: (row.utilitiesIncluded as boolean | null) ?? null,
    parkingIncluded: (row.parkingIncluded as boolean | null) ?? null,
    imageUrls: Array.isArray(row.imageUrls) ? (row.imageUrls as string[]) : null,
    createdAt: row.createdAt as Date,
  }));
}

function relaxFilters(
  filters: Omit<SearchRequest, "query" | "limit" | "excludeIds">,
  level: 1 | 2 | 3
): Omit<SearchRequest, "query" | "limit" | "excludeIds"> {
  if (level === 1) {
    return {
      ...filters,
      furnished: null,
      utilitiesIncluded: null,
      parkingIncluded: null,
      couplesOk: null,
    };
  }

  if (level === 2) {
    return {
      ...relaxFilters(filters, 1),
      rentMax:
        typeof filters.rentMax === "number"
          ? Math.ceil(filters.rentMax * 1.15)
          : filters.rentMax,
    };
  }

  return {
    ...relaxFilters(filters, 2),
    city: null,
  };
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

  const { query, limit: rawLimit, excludeIds, ...filters } = body;

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
    let candidates = await vectorSearchXhsRentalListings(
      embedding,
      VECTOR_CANDIDATE_LIMIT,
      excludeIds ?? []
    );
    let searchMode = "vector";

    if (candidates.length === 0) {
      candidates = await getSqlFallbackCandidates(excludeIds ?? []);
      searchMode = "sql_fallback";
    }

    const strictFiltered = applyFilters(candidates, filters);
    let filtered = strictFiltered;
    let action = "SHOW_LISTING";
    let relaxedNote: string | null = null;

    if (filtered.length === 0) {
      const level1 = applyFilters(candidates, relaxFilters(filters, 1));
      if (level1.length > 0) {
        filtered = level1;
        action = "SHOW_RELAXED_LISTING";
        relaxedNote =
          "没有完全匹配的房源；我先放宽家具、水电、停车、情侣入住等生活偏好，保留核心地点/预算/卧室要求。";
      }
    }

    if (filtered.length === 0) {
      const level2 = applyFilters(candidates, relaxFilters(filters, 2));
      if (level2.length > 0) {
        filtered = level2;
        action = "SHOW_RELAXED_LISTING";
        relaxedNote =
          "没有完全匹配的房源；我把预算上限大约放宽 15%，同时保留其他核心要求。";
      }
    }

    if (filtered.length === 0) {
      const level3 = applyFilters(candidates, relaxFilters(filters, 3));
      if (level3.length > 0) {
        filtered = level3;
        action = "SHOW_RELAXED_LISTING";
        relaxedNote =
          "没有完全匹配的房源；我放宽到附近区域/全湾区候选，但仍尽量保留预算和房型要求。";
      }
    }

    if (filtered.length === 0) {
      const noResultAction =
        Array.isArray(excludeIds) && excludeIds.length > 0
          ? "NO_MORE"
          : "NO_RESULTS";
      return Response.json({
        listings: [],
        count: 0,
        totalBeforeFilter: candidates.length,
        totalAfterFilter: 0,
        action: noResultAction,
        relaxedNote: null,
      searchMode,
        message:
          noResultAction === "NO_MORE"
            ? "No more listings matched after excluding listings already shown."
            : "No matching listings found after progressive relaxation.",
      });
    }

    const results = filtered.slice(0, limit);

    return Response.json({
      listings: results.map(toListingSummary),
      count: results.length,
      totalBeforeFilter: candidates.length,
      totalAfterFilter: filtered.length,
      action,
      relaxedNote,
      searchMode,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[gpt/search] error:", msg);
    return Response.json({ error: "Search failed", detail: msg }, { status: 500 });
  }
}
