/**
 * Backfill script: runs LLM field extraction on existing XhsRentalListing rows
 * that are missing the new structured columns (bedroomsNum, city, petFriendly, etc.).
 *
 * Usage:
 *   pnpm exec tsx scripts/backfill-listing-fields.ts
 *
 * Processes in batches of 10 to avoid overwhelming the LLM API.
 * Safe to re-run: only updates rows where ALL six new fields are NULL.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

if (process.env.POSTGRES_URL?.startsWith('"')) {
  process.env.POSTGRES_URL = process.env.POSTGRES_URL.slice(1, -1);
}

import postgres from "postgres";
import { generateObject } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { z } from "zod";

const client = postgres(process.env.POSTGRES_URL!);

const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY! });

const extractSchema = z.object({
  bedroomsNum: z.number().int().nullable(),
  city: z.string().nullable(),
  petFriendly: z.boolean().nullable(),
  couplesOk: z.boolean().nullable(),
  utilitiesIncluded: z.boolean().nullable(),
  parkingIncluded: z.boolean().nullable(),
});

async function extractFields(rawText: string) {
  const { object } = await generateObject({
    model: openai("gpt-4o-mini"),
    schema: extractSchema,
    system: `You are a data extractor for US Bay Area rental listings (Chinese/English).
Extract only these 6 fields. Return null for anything you cannot confidently determine.
- bedroomsNum: integer (studio=0, 一室=1, 两室=2, 三房=3); null if unclear
- city: standardized English city (圣何塞→San Jose, 旧金山/三藩→San Francisco, 奥克兰→Oakland, 伯克利→Berkeley, 山景城→Mountain View, 桑尼维尔→Sunnyvale, 圣克拉拉→Santa Clara, 弗里蒙特→Fremont, 帕洛阿尔托→Palo Alto, 库比蒂诺→Cupertino, 圣马特奥→San Mateo, 红木城→Redwood City); null if no clear Bay Area city
- petFriendly: true/false/null only when explicitly stated
- couplesOk: true/false/null only when explicitly stated
- utilitiesIncluded: true/false/null only when explicitly stated
- parkingIncluded: true/false/null only when explicitly stated`,
    prompt: rawText.slice(0, 3000),
  });
  return object;
}

const BATCH_SIZE = 10;
const DELAY_MS = 300;

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  console.log("🔍 Fetching rows missing structured fields...");

  const rows = await client<{ id: string; rawText: string }[]>`
    SELECT id, "rawText"
    FROM "XhsRentalListing"
    WHERE "bedroomsNum" IS NULL
      AND "city" IS NULL
      AND "petFriendly" IS NULL
      AND "couplesOk" IS NULL
      AND "utilitiesIncluded" IS NULL
      AND "parkingIncluded" IS NULL
    ORDER BY "createdAt" DESC
  `;

  console.log(`📋 Found ${rows.length} rows to backfill.`);
  if (rows.length === 0) {
    console.log("✅ Nothing to backfill.");
    await client.end();
    return;
  }

  let success = 0;
  let failed = 0;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    console.log(`\n[${i + 1}–${Math.min(i + BATCH_SIZE, rows.length)} / ${rows.length}]`);

    for (const row of batch) {
      try {
        const fields = await extractFields(row.rawText);
        await client`
          UPDATE "XhsRentalListing"
          SET
            "bedroomsNum"       = ${fields.bedroomsNum},
            "city"              = ${fields.city},
            "petFriendly"       = ${fields.petFriendly},
            "couplesOk"         = ${fields.couplesOk},
            "utilitiesIncluded" = ${fields.utilitiesIncluded},
            "parkingIncluded"   = ${fields.parkingIncluded}
          WHERE id = ${row.id}::uuid
        `;
        process.stdout.write(
          `  ✓ ${row.id.slice(0, 8)} → city=${fields.city ?? "null"} bedrooms=${fields.bedroomsNum ?? "null"} pet=${fields.petFriendly ?? "null"}\n`
        );
        success += 1;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stdout.write(`  ✗ ${row.id.slice(0, 8)} FAILED: ${msg}\n`);
        failed += 1;
      }

      await sleep(DELAY_MS);
    }
  }

  console.log(`\n🎉 Done. success=${success} failed=${failed}`);
  await client.end();
}

main().catch((e) => {
  console.error("Fatal:", e.message);
  process.exit(1);
});
