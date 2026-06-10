/**
 * queryListings — lets the LLM run read-only SQL against the
 * XhsRentalListing table to explore data before/after searching.
 *
 * Safety: only SELECT is accepted; a blocklist rejects any write keywords.
 * Results are capped at 100 rows to prevent huge payloads.
 */
import "server-only";

import { tool } from "ai";
import { z } from "zod";
import postgres from "postgres";

const MAX_ROWS = 100;

// biome-ignore lint/style/noNonNullAssertion: POSTGRES_URL required at runtime
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
];

export const queryListings = tool({
  description:
    "Run a read-only SQL SELECT query directly against the XhsRentalListing database table. " +
    "Use this to explore the data BEFORE calling searchRental — e.g. to discover what " +
    "cities/roomTypes exist, count listings, find rent ranges, or check availability dates. " +
    "You MUST use this tool when the user asks statistical or exploratory questions like " +
    "'how many listings are in San Jose', 'what is the cheapest 2BR', " +
    "'show me listings posted this week', 'what room types are available'. " +
    "Table name: \"XhsRentalListing\" (case-sensitive, double-quoted). " +
    'Columns: id (uuid), title, rent (text), deposit, bedrooms, bathrooms, ' +
    "roomType, listingType, furnished, locationText, propertyName, " +
    "availableFrom, leaseEndDate, contactMethod, rawText, sourceUrl, " +
    "imageUrls (json array), postedAt (timestamptz), createdAt (timestamptz). " +
    "All text columns store natural language — use ILIKE for filtering. " +
    "Always add LIMIT (max 100). Example: " +
    'SELECT "locationText", COUNT(*) AS cnt FROM "XhsRentalListing" ' +
    'GROUP BY "locationText" ORDER BY cnt DESC LIMIT 20',
  inputSchema: z.object({
    sqlQuery: z
      .string()
      .describe(
        'A PostgreSQL SELECT query against "XhsRentalListing". Must start with SELECT. Include LIMIT.'
      ),
  }),
  execute: async ({ sqlQuery }) => {
    const trimmed = sqlQuery.trim();

    if (!trimmed.toUpperCase().startsWith("SELECT")) {
      return { error: "Only SELECT queries are allowed.", rows: [] };
    }

    const upper = trimmed.toUpperCase();
    for (const kw of BLOCKED_KEYWORDS) {
      // Match as word boundary to avoid false positives (e.g. "SELECTED")
      if (new RegExp(`\\b${kw}\\b`).test(upper)) {
        return { error: `Query contains disallowed keyword: ${kw}`, rows: [] };
      }
    }

    try {
      const rows = await client.unsafe(trimmed);
      const limited = rows.slice(0, MAX_ROWS) as Record<string, unknown>[];
      return { rows: limited, rowCount: limited.length };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[queryListings] SQL error:", msg);
      return { error: `Query failed: ${msg}`, rows: [] };
    }
  },
});
