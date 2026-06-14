import { config } from "dotenv";
config({ path: ".env.local" });

// Strip surrounding quotes added by some .env editors
if (process.env.POSTGRES_URL?.startsWith('"')) {
  process.env.POSTGRES_URL = process.env.POSTGRES_URL.slice(1, -1);
}

import postgres from "postgres";

async function main() {
  const client = postgres(process.env.POSTGRES_URL!);
  console.log("Running migration: add rentNumeric column...");
  await client`ALTER TABLE "XhsRentalListing" ADD COLUMN IF NOT EXISTS "rentNumeric" integer`;
  console.log("✅ Column added (or already existed).");
  await client.end();
}

main().catch((e) => {
  console.error("❌ Migration failed:", e.message);
  process.exit(1);
});
