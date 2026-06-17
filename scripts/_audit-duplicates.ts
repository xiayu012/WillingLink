import { config } from "dotenv";
config({ path: ".env.local" });
if (process.env.POSTGRES_URL?.startsWith('"')) {
  process.env.POSTGRES_URL = process.env.POSTGRES_URL.slice(1, -1);
}
import postgres from "postgres";

const client = postgres(process.env.POSTGRES_URL!);

async function main() {
  // XhsRentalListing duplicates
  const listingDups = await client`
    SELECT "sourceUrl", COUNT(*) AS cnt
    FROM "XhsRentalListing"
    WHERE "sourceUrl" NOT LIKE 'pending:%'
    GROUP BY "sourceUrl"
    HAVING COUNT(*) > 1
    ORDER BY cnt DESC
    LIMIT 20
  `;
  const listingPending = await client`
    SELECT COUNT(*) AS cnt FROM "XhsRentalListing" WHERE "sourceUrl" LIKE 'pending:%'
  `;
  const listingTotal = await client`SELECT COUNT(*) AS cnt FROM "XhsRentalListing"`;

  // XhsRentalWanted
  const wantedDups = await client`
    SELECT "sourceUrl", COUNT(*) AS cnt
    FROM "XhsRentalWanted"
    WHERE "sourceUrl" NOT LIKE 'pending:%'
    GROUP BY "sourceUrl"
    HAVING COUNT(*) > 1
    ORDER BY cnt DESC
    LIMIT 10
  `;
  const wantedTotal = await client`SELECT COUNT(*) AS cnt FROM "XhsRentalWanted"`;

  // XhsRentalOther
  const otherDups = await client`
    SELECT "sourceUrl", COUNT(*) AS cnt
    FROM "XhsRentalOther"
    WHERE "sourceUrl" NOT LIKE 'pending:%'
    GROUP BY "sourceUrl"
    HAVING COUNT(*) > 1
    ORDER BY cnt DESC
    LIMIT 10
  `;
  const otherTotal = await client`SELECT COUNT(*) AS cnt FROM "XhsRentalOther"`;

  console.log("=== XhsRentalListing ===");
  console.log(`Total: ${listingTotal[0].cnt}, Pending URLs: ${listingPending[0].cnt}`);
  console.log(`Duplicate sourceUrls (real): ${listingDups.length}`);
  if (listingDups.length > 0) {
    for (const r of listingDups.slice(0, 5)) {
      console.log(`  ${r.sourceUrl?.slice(0, 60)} × ${r.cnt}`);
    }
  }

  console.log("\n=== XhsRentalWanted ===");
  console.log(`Total: ${wantedTotal[0].cnt}`);
  console.log(`Duplicate sourceUrls: ${wantedDups.length}`);

  console.log("\n=== XhsRentalOther ===");
  console.log(`Total: ${otherTotal[0].cnt}`);
  console.log(`Duplicate sourceUrls: ${otherDups.length}`);

  await client.end();
}
main().catch(e => { console.error(e); process.exit(1); });
