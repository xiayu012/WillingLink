import { listXhsRentalListings } from "@/lib/db/queries";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const MAX_OFFSET = 500_000;

function jsonWithCors(body: unknown, status = 200) {
  return Response.json(body, { status, headers: corsHeaders });
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

export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    return jsonWithCors({ error: "Unauthorized" }, 401);
  }

  const url = new URL(request.url);
  const limit = parseLimit(url.searchParams.get("limit"));
  const offset = parseOffset(url.searchParams.get("offset"));
  const q = url.searchParams.get("q");

  const { rows, total } = await listXhsRentalListings({
    limit,
    offset,
    search: q,
  });

  return jsonWithCors({
    listings: rows,
    total,
    limit,
    offset,
    hasMore: offset + rows.length < total,
  });
}
