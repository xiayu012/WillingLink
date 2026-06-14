/**
 * Backfill script: parse the "rent" text column → "rentNumeric" integer.
 *
 * Parsing rules (conservative, avoids false positives):
 *   - Extract the first contiguous digit sequence from the rent string.
 *   - Accept it only if it falls within [100, 15000] (reasonable monthly USD).
 *   - Daily-rate strings ("16-20/天"), zip-code mismatches, or unmatchable
 *     text ("面议") → NULL.
 *
 * Run: pnpm exec tsx scripts/backfill-rent-numeric.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });

if (process.env.POSTGRES_URL?.startsWith('"')) {
  process.env.POSTGRES_URL = process.env.POSTGRES_URL.slice(1, -1);
}

import postgres from "postgres";

const MIN_RENT = 100;
const MAX_RENT = 15_000;

function parseRent(rent: string | null): number | null {
  if (!rent) return null;
  const m = rent.match(/\d+/);
  if (!m) return null;
  const n = parseInt(m[0], 10);
  if (n < MIN_RENT || n > MAX_RENT) return null;
  return n;
}

async function main() {
  const client = postgres(process.env.POSTGRES_URL!);

  // Fetch all rows that haven't been filled yet
  const rows = await client<{ id: string; rent: string | null }[]>`
    SELECT id, rent FROM "XhsRentalListing"
    WHERE "rentNumeric" IS NULL
  `;

  console.log(`Found ${rows.length} rows to process.`);

  let updated = 0;
  let skipped = 0;

  for (const row of rows) {
    const parsed = parseRent(row.rent);
    if (parsed !== null) {
      await client`
        UPDATE "XhsRentalListing"
        SET "rentNumeric" = ${parsed}
        WHERE id = ${row.id}::uuid
      `;
      updated++;
    } else {
      skipped++;
    }
  }

  console.log(`✅ Done. Updated: ${updated}, Skipped (unparseable): ${skipped}`);
  await client.end();
}

main().catch((e) => {
  console.error("❌ Backfill failed:", e.message);
  process.exit(1);
});
