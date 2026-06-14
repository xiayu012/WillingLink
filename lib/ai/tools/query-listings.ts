/**
 * queryListings — lets the LLM run read-only SQL against XhsRentalListing.
 *
 * Features:
 *   - Full schema injection in description so the LLM knows every column.
 *   - Self-correction: on SQL error, returns the attempted query + hint so
 *     the LLM can fix and retry.
 *   - Safety: SELECT-only guard + keyword blocklist for write operations.
 *   - Results capped at 100 rows.
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

// ── Full schema description injected into the tool description ────────────────
// This is the single most impactful thing for Text-to-SQL accuracy.
// The LLM needs to know column names, types, and what the data looks like.
const SCHEMA_DESCRIPTION = `
Table: "XhsRentalListing" (case-sensitive, always double-quote it)

Columns and types:
  id             uuid          PRIMARY KEY
  sourceUrl      text          Original post URL (xiaohongshu / WeChat etc.)
  title          text NULL     Post headline; often null or short description
  rawText        text          Full post text in Chinese/English — use ILIKE for free-text search
  rent           text NULL     Monthly rent as free text, e.g. "880", "1704刀", "$1000/月", "面议"
  rentNumeric    integer NULL  Parsed monthly rent in USD (100–15000 range). NULL = unparseable.
                               USE THIS COLUMN for numeric rent filtering and sorting.
  deposit        text NULL     Deposit description, e.g. "一个月押金", "$1250"
  bedrooms       text NULL     Bedroom count/description, e.g. "1", "2", "三房", "两房"
  bathrooms      text NULL     Bathroom count, e.g. "1", "2"
  roomType       text NULL     Room type, e.g. "整套", "独立卧室", "主卧", "次卧", "套间"
  listingType    text NULL     Listing type, e.g. "整租", "合租", "sublet"
  furnished      text NULL     Furnishing, e.g. "全屋家具", "部分家具", "unfurnished"
  locationText   text NULL     Free-text address/area, e.g. "Fremont 94539", "旧金山近金门公园"
  propertyName   text NULL     Apartment complex name if mentioned
  availableFrom  text NULL     Move-in date (free text)
  leaseEndDate   text NULL     Lease end date (free text)
  contactMethod  text NULL     How to contact, e.g. WeChat ID, phone
  imageUrls      json NULL     Array of image URLs
  postedAt       timestamptz   When the post was published (use for recency queries)
  createdAt      timestamptz   When the record was inserted

Key query patterns:
  -- Count by city/area
  SELECT "locationText", COUNT(*) AS cnt FROM "XhsRentalListing"
  GROUP BY "locationText" ORDER BY cnt DESC LIMIT 20

  -- Numeric rent filter (use rentNumeric, not rent)
  SELECT id, title, "rentNumeric", "locationText"
  FROM "XhsRentalListing"
  WHERE "rentNumeric" IS NOT NULL AND "rentNumeric" <= 1500
  ORDER BY "rentNumeric" ASC LIMIT 20

  -- Cheapest listing
  SELECT id, title, rent, "rentNumeric", "locationText"
  FROM "XhsRentalListing"
  WHERE "rentNumeric" IS NOT NULL
  ORDER BY "rentNumeric" ASC LIMIT 5

  -- Posted this week
  SELECT id, title, "locationText", "postedAt"
  FROM "XhsRentalListing"
  WHERE "postedAt" > NOW() - INTERVAL '7 days'
  ORDER BY "postedAt" DESC LIMIT 20

  -- Full-text search (Chinese or English)
  SELECT id, title, "locationText"
  FROM "XhsRentalListing"
  WHERE "rawText" ILIKE '%宠物%' OR "rawText" ILIKE '%pet%'
  LIMIT 20

  -- Count total listings
  SELECT COUNT(*) FROM "XhsRentalListing"
`.trim();

export const queryListings = tool({
  description:
    "Run a read-only SQL SELECT query directly against the XhsRentalListing database table. " +
    "Use BEFORE searchRental to explore what data exists — count listings, find rent ranges, " +
    "discover cities, check room types, answer stats questions. " +
    "If the query fails with a SQL error, fix the query and call this tool again — " +
    "the error response will include your attempted query and a hint.\n\n" +
    SCHEMA_DESCRIPTION,
  inputSchema: z.object({
    sqlQuery: z
      .string()
      .describe(
        'A PostgreSQL SELECT query against "XhsRentalListing". ' +
          "Must start with SELECT. Always include LIMIT (max 100). " +
          "For rent filtering use rentNumeric (integer), not rent (text). " +
          "Example: SELECT rentNumeric, locationText FROM \"XhsRentalListing\" WHERE rentNumeric < 1500 ORDER BY rentNumeric ASC LIMIT 20"
      ),
  }),
  execute: async ({ sqlQuery }) => {
    const trimmed = sqlQuery.trim();

    if (!trimmed.toUpperCase().startsWith("SELECT")) {
      return {
        error: "Only SELECT queries are allowed.",
        attemptedQuery: trimmed,
        hint: "Rewrite the query starting with SELECT and call queryListings again.",
        rows: [],
      };
    }

    const upper = trimmed.toUpperCase();
    for (const kw of BLOCKED_KEYWORDS) {
      if (new RegExp(`\\b${kw}\\b`).test(upper)) {
        return {
          error: `Query contains disallowed keyword: ${kw}`,
          attemptedQuery: trimmed,
          hint: "Remove the disallowed keyword and call queryListings again.",
          rows: [],
        };
      }
    }

    try {
      const rows = await client.unsafe(trimmed);
      const limited = rows.slice(0, MAX_ROWS) as Record<string, unknown>[];
      return { rows: limited, rowCount: limited.length };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[queryListings] SQL error:", msg);
      // Return structured error so the LLM can self-correct and retry
      return {
        error: `SQL error: ${msg}`,
        attemptedQuery: trimmed,
        hint:
          "Fix the SQL syntax or column name error shown above, then call queryListings again with the corrected query. " +
          "Remember: table is \"XhsRentalListing\" (double-quoted), use rentNumeric for numeric rent filtering.",
        rows: [],
      };
    }
  },
});
