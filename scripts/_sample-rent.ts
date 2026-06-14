import { config } from "dotenv";
config({ path: ".env.local" });
// Strip surrounding quotes if present (some .env.local files quote values)
if (process.env.POSTGRES_URL?.startsWith('"')) {
  process.env.POSTGRES_URL = process.env.POSTGRES_URL.slice(1, -1);
}
import postgres from "postgres";

async function main() {
  const client = postgres(process.env.POSTGRES_URL!);
  const rows = await client`SELECT rent, deposit, bedrooms, "locationText" FROM "XhsRentalListing" WHERE rent IS NOT NULL LIMIT 40`;
  console.log(JSON.stringify(rows, null, 2));
  await client.end();
}
main().catch(console.error);
