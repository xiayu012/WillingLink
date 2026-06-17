/**
 * Migration: add contentHash column + UNIQUE constraints for deduplication.
 *
 * Strategy C:
 *   - sourceUrl UNIQUE (partial: only where NOT LIKE 'pending:%')
 *   - contentHash text UNIQUE on all three tables (SHA-256 of rawText)
 */
import { config } from "dotenv";
config({ path: ".env.local" });
if (process.env.POSTGRES_URL?.startsWith('"')) {
  process.env.POSTGRES_URL = process.env.POSTGRES_URL.slice(1, -1);
}
import postgres from "postgres";
import { createHash } from "crypto";

const client = postgres(process.env.POSTGRES_URL!);

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

async function main() {
  console.log("Step 1: Add contentHash columns...");
  await client`ALTER TABLE "XhsRentalListing" ADD COLUMN IF NOT EXISTS "contentHash" text`;
  await client`ALTER TABLE "XhsRentalWanted"  ADD COLUMN IF NOT EXISTS "contentHash" text`;
  await client`ALTER TABLE "XhsRentalOther"   ADD COLUMN IF NOT EXISTS "contentHash" text`;
  console.log("  ✓ contentHash columns added");

  // ── Step 2: Backfill contentHash ──────────────────────────────────────────
  console.log("Step 2: Backfill contentHash for existing rows...");

  const listings = await client<{ id: string; rawText: string }[]>`
    SELECT id, "rawText" FROM "XhsRentalListing" WHERE "contentHash" IS NULL
  `;
  for (const row of listings) {
    const hash = sha256(row.rawText);
    await client`UPDATE "XhsRentalListing" SET "contentHash" = ${hash} WHERE id = ${row.id}::uuid`;
  }
  console.log(`  ✓ XhsRentalListing: ${listings.length} rows backfilled`);

  const wanteds = await client<{ id: string; rawText: string }[]>`
    SELECT id, "rawText" FROM "XhsRentalWanted" WHERE "contentHash" IS NULL
  `;
  for (const row of wanteds) {
    const hash = sha256(row.rawText);
    await client`UPDATE "XhsRentalWanted" SET "contentHash" = ${hash} WHERE id = ${row.id}::uuid`;
  }
  console.log(`  ✓ XhsRentalWanted: ${wanteds.length} rows backfilled`);

  const others = await client<{ id: string; rawText: string }[]>`
    SELECT id, "rawText" FROM "XhsRentalOther" WHERE "contentHash" IS NULL
  `;
  for (const row of others) {
    const hash = sha256(row.rawText);
    await client`UPDATE "XhsRentalOther" SET "contentHash" = ${hash} WHERE id = ${row.id}::uuid`;
  }
  console.log(`  ✓ XhsRentalOther: ${others.length} rows backfilled`);

  // ── Step 3: Delete duplicates by sourceUrl (keep oldest) ─────────────────
  console.log("Step 3: Delete duplicate sourceUrl rows (keep oldest)...");

  const deletedListing = await client`
    DELETE FROM "XhsRentalListing"
    WHERE id IN (
      SELECT id FROM (
        SELECT id,
               ROW_NUMBER() OVER (PARTITION BY "sourceUrl" ORDER BY "createdAt" ASC) AS rn
        FROM "XhsRentalListing"
        WHERE "sourceUrl" NOT LIKE 'pending:%'
      ) t
      WHERE rn > 1
    )
  `;
  console.log(`  ✓ XhsRentalListing: ${deletedListing.count} duplicate rows deleted`);

  const deletedWanted = await client`
    DELETE FROM "XhsRentalWanted"
    WHERE id IN (
      SELECT id FROM (
        SELECT id,
               ROW_NUMBER() OVER (PARTITION BY "sourceUrl" ORDER BY "createdAt" ASC) AS rn
        FROM "XhsRentalWanted"
        WHERE "sourceUrl" NOT LIKE 'pending:%'
      ) t
      WHERE rn > 1
    )
  `;
  console.log(`  ✓ XhsRentalWanted: ${deletedWanted.count} duplicate rows deleted`);

  // ── Step 4: Delete duplicates by contentHash (keep oldest) ───────────────
  console.log("Step 4: Delete duplicate contentHash rows (keep oldest)...");

  const deletedHashListing = await client`
    DELETE FROM "XhsRentalListing"
    WHERE id IN (
      SELECT id FROM (
        SELECT id,
               ROW_NUMBER() OVER (PARTITION BY "contentHash" ORDER BY "createdAt" ASC) AS rn
        FROM "XhsRentalListing"
        WHERE "contentHash" IS NOT NULL
      ) t
      WHERE rn > 1
    )
  `;
  console.log(`  ✓ XhsRentalListing contentHash dupes: ${deletedHashListing.count} deleted`);

  const deletedHashWanted = await client`
    DELETE FROM "XhsRentalWanted"
    WHERE id IN (
      SELECT id FROM (
        SELECT id,
               ROW_NUMBER() OVER (PARTITION BY "contentHash" ORDER BY "createdAt" ASC) AS rn
        FROM "XhsRentalWanted"
        WHERE "contentHash" IS NOT NULL
      ) t
      WHERE rn > 1
    )
  `;
  console.log(`  ✓ XhsRentalWanted contentHash dupes: ${deletedHashWanted.count} deleted`);

  // ── Step 5: Add UNIQUE constraints ───────────────────────────────────────
  console.log("Step 5: Adding UNIQUE constraints...");

  // sourceUrl partial unique (exclude pending:)
  await client`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_listing_sourceurl
    ON "XhsRentalListing" ("sourceUrl")
    WHERE "sourceUrl" NOT LIKE 'pending:%'
  `;
  await client`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_wanted_sourceurl
    ON "XhsRentalWanted" ("sourceUrl")
    WHERE "sourceUrl" NOT LIKE 'pending:%'
  `;
  await client`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_other_sourceurl
    ON "XhsRentalOther" ("sourceUrl")
    WHERE "sourceUrl" NOT LIKE 'pending:%'
  `;
  console.log("  ✓ sourceUrl partial UNIQUE indexes created");

  // contentHash unique
  await client`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_listing_contenthash
    ON "XhsRentalListing" ("contentHash")
    WHERE "contentHash" IS NOT NULL
  `;
  await client`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_wanted_contenthash
    ON "XhsRentalWanted" ("contentHash")
    WHERE "contentHash" IS NOT NULL
  `;
  await client`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_other_contenthash
    ON "XhsRentalOther" ("contentHash")
    WHERE "contentHash" IS NOT NULL
  `;
  console.log("  ✓ contentHash partial UNIQUE indexes created");

  // ── Final summary ─────────────────────────────────────────────────────────
  const finalListing = await client`SELECT COUNT(*) AS cnt FROM "XhsRentalListing"`;
  const finalWanted  = await client`SELECT COUNT(*) AS cnt FROM "XhsRentalWanted"`;
  const finalOther   = await client`SELECT COUNT(*) AS cnt FROM "XhsRentalOther"`;
  console.log("\n🎉 Migration complete!");
  console.log(`  XhsRentalListing: ${finalListing[0].cnt} rows`);
  console.log(`  XhsRentalWanted:  ${finalWanted[0].cnt} rows`);
  console.log(`  XhsRentalOther:   ${finalOther[0].cnt} rows`);

  await client.end();
}

main().catch(e => { console.error("❌", e.message); process.exit(1); });
