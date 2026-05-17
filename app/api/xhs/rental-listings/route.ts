import {
  listXhsRentalListings,
  type XhsRentalListingSort,
} from "@/lib/db/queries";
import { ChatSDKError } from "@/lib/errors";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const MAX_OFFSET = 500_000;

function jsonWithCors(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: {
      ...corsHeaders,
      "Cache-Control": "private, max-age=0, must-revalidate",
    },
  });
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders });
}

function isAuthorized(request: Request): boolean {
  const secret = process.env.XHS_RENTAL_LISTINGS_READ_SECRET;
  if (!secret || secret.length === 0) {
    return true;
  }
  const auth = request.headers.get("authorization");
  return auth === `Bearer ${secret}`;
}

function parseLimit(value: string | null): number {
  if (value === null) {
    return DEFAULT_LIMIT;
  }
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 1) {
    return DEFAULT_LIMIT;
  }
  return Math.min(n, MAX_LIMIT);
}

function parseOffset(value: string | null): number {
  if (value === null) {
    return 0;
  }
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 0) {
    return 0;
  }
  return Math.min(n, MAX_OFFSET);
}

function parseBool(value: string | null, defaultValue: boolean): boolean {
  if (value === null) {
    return defaultValue;
  }
  const t = value.trim().toLowerCase();
  if (t === "1" || t === "true" || t === "yes") {
    return true;
  }
  if (t === "0" || t === "false" || t === "no") {
    return false;
  }
  return defaultValue;
}

function parseOptionalTrimmed(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const t = value.trim();
  return t.length > 0 ? t : null;
}

function parseOptionalPositiveInt(value: string | null): number | null {
  if (value === null) {
    return null;
  }
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 1) {
    return null;
  }
  return n;
}

function parseSort(value: string | null): XhsRentalListingSort {
  if (value === "createdAt_asc") {
    return "createdAt_asc";
  }
  return "createdAt_desc";
}

export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    return jsonWithCors({ error: "Unauthorized" }, 401);
  }

  try {
    const url = new URL(request.url);
    const limit = parseLimit(url.searchParams.get("limit"));
    const offset = parseOffset(url.searchParams.get("offset"));
    const q = url.searchParams.get("q");
    const includeTotal = parseBool(url.searchParams.get("includeTotal"), true);
    const compact = parseBool(url.searchParams.get("compact"), false);
    const rawTextSnippetLength =
      parseOptionalPositiveInt(url.searchParams.get("snippet")) ?? 480;
    const rawTextMaxChars = parseOptionalPositiveInt(
      url.searchParams.get("rawTextMax")
    );
    const locationHint = parseOptionalTrimmed(url.searchParams.get("location"));
    const listingType = parseOptionalTrimmed(
      url.searchParams.get("listingType")
    );
    const bedrooms = parseOptionalTrimmed(url.searchParams.get("bedrooms"));
    const bathrooms = parseOptionalTrimmed(url.searchParams.get("bathrooms"));
    const roomType = parseOptionalTrimmed(url.searchParams.get("roomType"));
    const furnished = parseOptionalTrimmed(url.searchParams.get("furnished"));
    const sort = parseSort(url.searchParams.get("sort"));
    const cursorAfter = parseOptionalTrimmed(url.searchParams.get("cursor"));

    const result = await listXhsRentalListings({
      limit,
      offset,
      includeTotal,
      compact,
      rawTextSnippetLength,
      rawTextMaxChars,
      search: q,
      locationHint,
      listingType,
      bedrooms,
      bathrooms,
      roomType,
      furnished,
      sort,
      cursorAfter,
    });

    const usedCursor = cursorAfter !== null;
    let hasMore: boolean;
    if (usedCursor) {
      hasMore = result.rows.length === limit;
    } else if (result.total !== null) {
      hasMore = offset + result.rows.length < result.total;
    } else {
      hasMore = result.rows.length === limit;
    }

    return jsonWithCors({
      listings: result.rows,
      total: result.total,
      compact: result.compact,
      nextCursor: result.nextCursor,
      limit,
      offset,
      sort,
      hasMore,
    });
  } catch (error) {
    if (error instanceof ChatSDKError) {
      return error.toResponse();
    }
    throw error;
  }
}
