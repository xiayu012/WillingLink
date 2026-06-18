/**
 * POST /api/gpt/query
 *
 * Read-only SQL exploration endpoint for Custom GPT Actions.
 * Mirrors the in-app queryListings tool, with SELECT-only safety checks.
 */
import "server-only";

import postgres from "postgres";
import { requireGptKey } from "@/lib/api/gpt-auth";

const MAX_ROWS = 100;

// biome-ignore lint/style/noNonNullAssertion: required env var
const client = postgres(process.env.POSTGRES_URL!);

const BLOCKED_KEYWORDS = [
  "DROP",
  "DELETE",
  "INSERT",
  "UPDATE",
  "ALTER",
  "TRUNCATE",
  "GRANT",
  "REVOKE",
  "EXECUTE",
  "CALL",
] as const;

type QueryRequest = {
  sqlQuery: string;
};

export async function OPTIONS() {
  return new Response(null, { status: 204 });
}

export async function POST(request: Request) {
  const denied = requireGptKey(request);
  if (denied) return denied;

  let body: QueryRequest;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const trimmed = body.sqlQuery?.trim() ?? "";

  if (!trimmed.toUpperCase().startsWith("SELECT")) {
    return Response.json({
      error: "Only SELECT queries are allowed.",
      attemptedQuery: trimmed,
      hint: 'Rewrite the query starting with SELECT against "XhsRentalListing".',
      rows: [],
    });
  }

  const upper = trimmed.toUpperCase();
  for (const keyword of BLOCKED_KEYWORDS) {
    if (new RegExp(`\\b${keyword}\\b`).test(upper)) {
      return Response.json({
        error: `Query contains disallowed keyword: ${keyword}`,
        attemptedQuery: trimmed,
        hint: "Remove the disallowed keyword and retry.",
        rows: [],
      });
    }
  }

  try {
    const rows = await client.unsafe(trimmed);
    const limited = rows.slice(0, MAX_ROWS) as Record<string, unknown>[];
    return Response.json({ rows: limited, rowCount: limited.length });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[gpt/query] SQL error:", msg);
    return Response.json({
      error: `SQL error: ${msg}`,
      attemptedQuery: trimmed,
      hint:
        'Fix SQL syntax or column names, then retry. Table name is "XhsRentalListing" and must be double-quoted.',
      rows: [],
    });
  }
}
