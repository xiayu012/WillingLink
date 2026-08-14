/**
 * Test script for database-content API
 * Usage: npx tsx scripts/test-database-content.ts
 */
import postgres from "postgres";

async function main() {
  const dbUrl = process.env.POSTGRES_URL;
  if (!dbUrl) {
    console.error("Error: POSTGRES_URL environment variable not set");
    process.exit(1);
  }

  const client = postgres(dbUrl);

  const tables = [
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

  console.log("Database Table Statistics:");
  console.log("==========================\n");

  for (const table of tables) {
    try {
      const result = await client`
        SELECT COUNT(*) as count FROM ${client(table)}
      `;
      const count = Number(result[0]?.count ?? 0);
      console.log(`${table.padEnd(25)} : ${count} rows`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`${table.padEnd(25)} : ERROR - ${msg}`);
    }
  }

  await client.end();
  console.log("\n✓ Test completed");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
