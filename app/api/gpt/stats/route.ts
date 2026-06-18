/**
 * GET /api/gpt/stats
 *
 * Returns an overview of the XhsRentalListing database for Custom GPT Actions.
 * Useful as a first call so the GPT understands what data is available.
 *
 * Authentication: Authorization: Bearer <WILLINGLINK_GPT_API_KEY>
 */
import "server-only";

import postgres from "postgres";
import { requireGptKey } from "@/lib/api/gpt-auth";

// biome-ignore lint/style/noNonNullAssertion: required env var
const client = postgres(process.env.POSTGRES_URL!);

export async function OPTIONS() {
  return new Response(null, { status: 204 });
}

export async function GET(request: Request) {
  const denied = requireGptKey(request);
  if (denied) return denied;

  try {
    const [totalRow, cityRows, rentRows, bedroomsRows, featuresRows] =
      await Promise.all([
        // total count
        client`SELECT COUNT(*)::int AS total FROM "XhsRentalListing"`,

        // listings per city (structured field, English)
        client`
          SELECT city, COUNT(*)::int AS count
          FROM "XhsRentalListing"
          WHERE city IS NOT NULL
          GROUP BY city
          ORDER BY count DESC
        `,

        // rent stats
        client`
          SELECT
            MIN("rentNumeric")::int        AS min,
            MAX("rentNumeric")::int        AS max,
            PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY "rentNumeric")::int AS median,
            PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY "rentNumeric")::int AS p25,
            PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY "rentNumeric")::int AS p75
          FROM "XhsRentalListing"
          WHERE "rentNumeric" IS NOT NULL
        `,

        // bedrooms distribution
        client`
          SELECT "bedroomsNum", COUNT(*)::int AS count
          FROM "XhsRentalListing"
          WHERE "bedroomsNum" IS NOT NULL
          GROUP BY "bedroomsNum"
          ORDER BY "bedroomsNum"
        `,

        // boolean feature counts
        client`
          SELECT
            COUNT(*) FILTER (WHERE "petFriendly" = true)::int      AS petFriendlyCount,
            COUNT(*) FILTER (WHERE "couplesOk" = true)::int        AS couplesOkCount,
            COUNT(*) FILTER (WHERE "utilitiesIncluded" = true)::int AS utilitiesIncludedCount,
            COUNT(*) FILTER (WHERE "parkingIncluded" = true)::int  AS parkingIncludedCount
          FROM "XhsRentalListing"
        `,
      ]);

    return Response.json({
      totalListings: (totalRow[0]?.total as number) ?? 0,
      byCity: cityRows.map((r) => ({
        city: r.city as string,
        count: r.count as number,
      })),
      rentStats: {
        min: (rentRows[0]?.min as number) ?? null,
        max: (rentRows[0]?.max as number) ?? null,
        median: (rentRows[0]?.median as number) ?? null,
        p25: (rentRows[0]?.p25 as number) ?? null,
        p75: (rentRows[0]?.p75 as number) ?? null,
        currency: "USD/month",
      },
      byBedroomsNum: bedroomsRows.map((r) => ({
        bedroomsNum: r.bedroomsNum as number,
        label:
          (r.bedroomsNum as number) === 0
            ? "Studio"
            : `${r.bedroomsNum as number}BR`,
        count: r.count as number,
      })),
      features: {
        petFriendly: (featuresRows[0]?.petFriendlyCount as number) ?? 0,
        couplesOk: (featuresRows[0]?.couplesOkCount as number) ?? 0,
        utilitiesIncluded:
          (featuresRows[0]?.utilitiesIncludedCount as number) ?? 0,
        parkingIncluded:
          (featuresRows[0]?.parkingIncludedCount as number) ?? 0,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[gpt/stats] error:", msg);
    return Response.json({ error: "Stats query failed", detail: msg }, { status: 500 });
  }
}
