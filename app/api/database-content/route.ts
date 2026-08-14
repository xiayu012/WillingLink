/**
 * GET /api/database-content
 *
 * Returns the contents of database tables.
 * Query parameters:
 *   - table: Table name to query (User, Chat, Message_v2, XhsRentalListing, etc.)
 *            If omitted, returns list of all table names
 *   - limit: Number of rows to return (default: 10, max: 1000)
 *   - offset: Number of rows to skip (default: 0)
 *
 * Authentication: Authorization: Bearer <WILLINGLINK_GPT_API_KEY>
 */
import "server-only";

import postgres from "postgres";
import { requireGptKey } from "@/lib/api/gpt-auth";

// biome-ignore lint/style/noNonNullAssertion: required env var
const client = postgres(process.env.POSTGRES_URL!);

const AVAILABLE_TABLES = [
  "User",
  "Chat",
  "Message_v2",
  "Vote_v2",
  "Document",
  "Suggestion",
  "Stream",
  "Shift",
  "SearchAudio",
  "SearchQueryLog",
  "XhsRentalListing",
  "XhsRentalWanted",
  "XhsRentalOther",
];

export async function OPTIONS() {
  return new Response(null, { status: 204 });
}

export async function GET(request: Request) {
  const denied = requireGptKey(request);
  if (denied) return denied;

  const url = new URL(request.url);
  const table = url.searchParams.get("table");
  const limitParam = url.searchParams.get("limit") ?? "10";
  const offsetParam = url.searchParams.get("offset") ?? "0";

  const limit = Math.min(Math.max(1, parseInt(limitParam) || 10), 1000);
  const offset = Math.max(0, parseInt(offsetParam) || 0);

  // If no table specified, return metadata about available tables
  if (!table) {
    try {
      const stats = await Promise.all(
        AVAILABLE_TABLES.map(async (tableName) => {
          try {
            const result = await client`
              SELECT COUNT(*) as count FROM ${client(tableName)}
            `;
            return {
              name: tableName,
              count: Number(result[0]?.count ?? 0),
            };
          } catch {
            return {
              name: tableName,
              count: null,
              error: "Failed to count rows",
            };
          }
        })
      );

      return Response.json({
        availableTables: stats,
        usage: `Query a specific table: GET /api/database-content?table=TableName&limit=10&offset=0`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[database-content] error getting table stats:", msg);
      return Response.json(
        { error: "Failed to retrieve table stats", detail: msg },
        { status: 500 }
      );
    }
  }

  // Validate table name
  if (!AVAILABLE_TABLES.includes(table)) {
    return Response.json(
      {
        error: `Unknown table: ${table}`,
        availableTables: AVAILABLE_TABLES,
      },
      { status: 400 }
    );
  }

  try {
    const rows = await client`
      SELECT * FROM ${client(table)}
      LIMIT ${limit}
      OFFSET ${offset}
    `;

    const countResult = await client`
      SELECT COUNT(*) as total FROM ${client(table)}
    `;

    const total = Number(countResult[0]?.total ?? 0);

    return Response.json({
      table,
      rowCount: rows.length,
      totalRows: total,
      limit,
      offset,
      hasMore: offset + rows.length < total,
      rows,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[database-content] error querying ${table}:`, msg);
    return Response.json(
      { error: "Database query failed", detail: msg },
      { status: 500 }
    );
  }
}
