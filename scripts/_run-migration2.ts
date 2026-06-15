import { config } from "dotenv";
config({ path: ".env.local" });

if (process.env.POSTGRES_URL?.startsWith('"')) {
  process.env.POSTGRES_URL = process.env.POSTGRES_URL.slice(1, -1);
}

import postgres from "postgres";

async function main() {
  const client = postgres(process.env.POSTGRES_URL!);
  console.log("Running migration: add structured listing fields...");

  await client`ALTER TABLE "XhsRentalListing" ADD COLUMN IF NOT EXISTS "bedroomsNum" integer`;
  await client`ALTER TABLE "XhsRentalListing" ADD COLUMN IF NOT EXISTS "city" text`;
  await client`ALTER TABLE "XhsRentalListing" ADD COLUMN IF NOT EXISTS "petFriendly" boolean`;
  await client`ALTER TABLE "XhsRentalListing" ADD COLUMN IF NOT EXISTS "couplesOk" boolean`;
  await client`ALTER TABLE "XhsRentalListing" ADD COLUMN IF NOT EXISTS "utilitiesIncluded" boolean`;
  await client`ALTER TABLE "XhsRentalListing" ADD COLUMN IF NOT EXISTS "parkingIncluded" boolean`;

  console.log("✅ All 6 columns added (or already existed).");
  await client.end();
}

main().catch((e) => {
  console.error("❌ Migration failed:", e.message);
  process.exit(1);
});
