/**
 * 一次性回填脚本：为 XhsRentalListing 表中所有缺少 embedding 的行生成向量。
 *
 * 使用方法：
 *   npx tsx scripts/embed-listings.ts
 *
 * 前置条件：
 *   1. .env.local 中已配置 POSTGRES_URL 和 VOYAGE_API_KEY
 *   2. 数据库已执行 tools/xhs-guide/db/add_vector_embedding.sql
 *      （添加 embedding vector(1024) 列 + HNSW 索引）
 */

import { config } from "dotenv";
import postgres from "postgres";
import { VoyageAIClient } from "voyageai";

type EmbedDataItem = { index?: number; embedding?: number[] };

config({ path: ".env.local" });

const BATCH_SIZE = 32;
const EMBED_MODEL = "voyage-3";

const db = postgres(process.env.POSTGRES_URL!);
// biome-ignore lint: required env var
const voyage = new VoyageAIClient({ apiKey: process.env.VOYAGE_API_KEY! });

type RawRow = {
  id: string;
  rawText: string;
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

  const rows = await db<RawRow[]>`
    SELECT id, "rawText"
    FROM "XhsRentalListing"
    WHERE embedding IS NULL
    ORDER BY "createdAt" DESC
  `;

  console.log(`Found ${rows.length} listings without embeddings.`);
  if (rows.length === 0) {
    console.log("Nothing to do.");
    await db.end();
    return;
  }

  let done = 0;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const texts = batch.map((row) => row.rawText);

    const res = await voyage.embed({
      input: texts,
      model: EMBED_MODEL,
      inputType: "document",
    });

    const embeddings = (res.data ?? [])
      .slice()
      .sort((a: EmbedDataItem, b: EmbedDataItem) => (a.index ?? 0) - (b.index ?? 0))
      .map((d: EmbedDataItem) => d.embedding ?? []);

    for (let j = 0; j < batch.length; j++) {
      const vectorLiteral = `[${embeddings[j].join(",")}]`;
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
