/**
 * Migration 4: finish deduplication cleanup (Strategy C).
 *
 * 1. Re-backfill "contentHash" for any rows left NULL by the earlier
 *    regression window (app code briefly stopped computing/passing it).
 *    Rows are deduped against already-hashed rows AND against each other
 *    before the UPDATE runs, so the existing partial UNIQUE index on
 *    "contentHash" is never violated mid-backfill.
 * 2. Drop the orphaned "textHash" column + index (unused, 0% filled,
 *    fully superseded by "contentHash").
 */
import { config } from "dotenv";

config({ path: ".env.local" });
if (process.env.POSTGRES_URL?.startsWith('"')) {
  process.env.POSTGRES_URL = process.env.POSTGRES_URL.slice(1, -1);
}

import { createHash } from "node:crypto";
import postgres from "postgres";

const client = postgres(process.env.POSTGRES_URL!);

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

type Row = { id: string; rawText: string };

async function backfillAndDedupe(
  table: "XhsRentalListing" | "XhsRentalWanted" | "XhsRentalOther"
) {
  const existingHashes = await client<{ contentHash: string }[]>`
    SELECT DISTINCT "contentHash" FROM ${client(table)} WHERE "contentHash" IS NOT NULL
  `;
  const seen = new Set(existingHashes.map((r) => r.contentHash));

  const nullRows = await client<Row[]>`
    SELECT id, "rawText" FROM ${client(table)}
    WHERE "contentHash" IS NULL
    ORDER BY "createdAt" ASC
  `;

  let backfilled = 0;
  let deletedAsDupe = 0;
  for (const row of nullRows) {
    const hash = sha256(row.rawText);
    if (seen.has(hash)) {
      await client`DELETE FROM ${client(table)} WHERE id = ${row.id}::uuid`;
      deletedAsDupe += 1;
      continue;
    }
    seen.add(hash);
    await client`UPDATE ${client(table)} SET "contentHash" = ${hash} WHERE id = ${row.id}::uuid`;
    backfilled += 1;
  }
  console.log(
    `  ✓ ${table}: ${backfilled} backfilled, ${deletedAsDupe} duplicate rows deleted`
  );
}

async function dropTextHash(
  table: "XhsRentalListing" | "XhsRentalWanted" | "XhsRentalOther"
) {
  await client`DROP INDEX IF EXISTS idx_xhs_listing_texthash`;
  await client`ALTER TABLE ${client(table)} DROP COLUMN IF EXISTS "textHash"`;
}

async function main() {
  console.log("Step 1: Re-backfill contentHash + dedupe leftover NULL rows...");
  await backfillAndDedupe("XhsRentalListing");
  await backfillAndDedupe("XhsRentalWanted");
  await backfillAndDedupe("XhsRentalOther");

  console.log("Step 2: Drop orphaned textHash column + index...");
  await dropTextHash("XhsRentalListing");
  await dropTextHash("XhsRentalWanted");
  await dropTextHash("XhsRentalOther");
  console.log("  ✓ textHash column + index dropped from all 3 tables");

  const finalListing =
    await client`SELECT COUNT(*) AS cnt, COUNT("contentHash") AS hashed FROM "XhsRentalListing"`;
  const finalWanted =
    await client`SELECT COUNT(*) AS cnt, COUNT("contentHash") AS hashed FROM "XhsRentalWanted"`;
  const finalOther =
    await client`SELECT COUNT(*) AS cnt, COUNT("contentHash") AS hashed FROM "XhsRentalOther"`;
  console.log("\n🎉 Migration 4 complete!");
  console.log(
    `  XhsRentalListing: ${finalListing[0].cnt} rows, ${finalListing[0].hashed} hashed`
  );
  console.log(
    `  XhsRentalWanted:  ${finalWanted[0].cnt} rows, ${finalWanted[0].hashed} hashed`
  );
  console.log(
    `  XhsRentalOther:   ${finalOther[0].cnt} rows, ${finalOther[0].hashed} hashed`
  );

  await client.end();
}

main().catch((e) => {
  console.error("❌", e.message);
  process.exit(1);
});
