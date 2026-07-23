/**
 * 回填脚本：为 XhsRentalListing 生成向量。
 *
 * 使用方法：
 *   npx tsx scripts/embed-listings.ts          # 只补缺失 embedding 的行
 *   npx tsx scripts/embed-listings.ts --all    # 全量重嵌（嵌入文档格式变更后用）
 *
 * 与入库环节（app/api/xhs/rental-ingest）使用同一份
 * composeListingEmbeddingDoc，保证所有向量在同一语义空间。
 *
 * 前置条件：.env.local 中已配置 POSTGRES_URL 和 VOYAGE_API_KEY。
 */

import { config } from "dotenv";
import postgres from "postgres";
import { embedBatch } from "../lib/ai/embeddings";
import { composeListingEmbeddingDoc } from "../lib/rental/listing-embedding";

config({ path: ".env.local" });
for (const key of ["POSTGRES_URL", "VOYAGE_API_KEY"]) {
  const v = process.env[key];
  if (v?.startsWith('"')) {
    process.env[key] = v.slice(1, -1);
  }
}

const BATCH_SIZE = 32;
const REEMBED_ALL = process.argv.includes("--all");

const db = postgres(process.env.POSTGRES_URL!);

type ListingRow = {
  id: string;
  rawText: string;
  title: string | null;
  city: string | null;
  locationText: string | null;
  propertyName: string | null;
  rent: string | null;
  roomType: string | null;
  bedrooms: string | null;
  bathrooms: string | null;
  listingType: string | null;
  availableFrom: string | null;
  furnished: string | null;
};

async function runMigration(): Promise<void> {
  console.log("⏳ Ensuring pgvector extension and embedding column exist...");
  await db`CREATE EXTENSION IF NOT EXISTS vector`;
  await db`
    ALTER TABLE "XhsRentalListing"
      ADD COLUMN IF NOT EXISTS embedding vector(1024)
  `;
  await db`
    CREATE INDEX IF NOT EXISTS xhs_rental_embedding_hnsw_idx
      ON "XhsRentalListing"
      USING hnsw (embedding vector_cosine_ops)
      WITH (m = 16, ef_construction = 64)
  `;
  console.log("✅ Migration done.");
}

async function main(): Promise<void> {
  await runMigration();

  const rows = await db<ListingRow[]>`
    SELECT
      id, "rawText", "title", "city", "locationText", "propertyName",
      "rent", "roomType", "bedrooms", "bathrooms", "listingType",
      "availableFrom", "furnished"
    FROM "XhsRentalListing"
    WHERE trim("rawText") <> ''
      ${REEMBED_ALL ? db`` : db`AND embedding IS NULL`}
    ORDER BY "createdAt" DESC
  `;

  console.log(
    `Found ${rows.length} listings to embed (${REEMBED_ALL ? "re-embed all" : "missing only"}).`
  );
  if (rows.length === 0) {
    console.log("Nothing to do.");
    await db.end();
    return;
  }

  let done = 0;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const docs = batch.map((row) => composeListingEmbeddingDoc(row));
    const embeddings = await embedBatch(docs, "document");

    for (let j = 0; j < batch.length; j++) {
      const vec = embeddings[j];
      if (!vec || vec.length === 0) {
        console.warn(`  ⚠ empty embedding for ${batch[j].id}, skipping`);
        continue;
      }
      const vectorLiteral = `[${vec.join(",")}]`;
      await db`
        UPDATE "XhsRentalListing"
        SET embedding = ${vectorLiteral}::vector
        WHERE id = ${batch[j].id}::uuid
      `;
    }

    done += batch.length;
    console.log(`  ${done}/${rows.length} embedded...`);
  }

  console.log(`✅ All done! ${done} listings embedded.`);
  await db.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
