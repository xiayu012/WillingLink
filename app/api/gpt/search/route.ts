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
import {
  applyBlockTerms,
  applyHardConstraints,
  constraintsFromParams,
  relaxationLevels,
} from "@/lib/rental/query-constraints";
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
            "leaseMinMonths", "leaseMaxMonths",
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
            "leaseMinMonths", "leaseMaxMonths",
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
    leaseMinMonths: (row.leaseMinMonths as number | null) ?? null,
    leaseMaxMonths: (row.leaseMaxMonths as number | null) ?? null,
    imageUrls: Array.isArray(row.imageUrls) ? (row.imageUrls as string[]) : null,
    createdAt: row.createdAt as Date,
  }));
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

    // Same brain as the in-app searchRental tool: block-term exclusion, then the
    // shared hard-constraint ladder (budget / bedrooms / move-in feasibility /
    // pet / couples / utilities / parking / furnished, with neighbour-aware
    // city). Typed params are merged with anything the NL query also expresses.
    const constraints = constraintsFromParams(filters, query.trim());
    const blockTerms = filters.mustNotContain ?? [];
    const pool = applyBlockTerms(candidates, blockTerms);

    let filtered: XhsRentalSearchResultRow[] = [];
    let action = "SHOW_LISTING";
    let relaxedNote: string | null = null;

    for (const level of relaxationLevels(constraints)) {
      const matched = applyHardConstraints(pool, level.constraints);
      if (matched.length > 0) {
        filtered = matched;
        relaxedNote = level.note;
        action = level.note ? "SHOW_RELAXED_LISTING" : "SHOW_LISTING";
        break;
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
