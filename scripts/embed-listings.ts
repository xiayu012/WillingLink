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
  title: string | null;
  rawText: string;
  locationText: string | null;
  rent: string | null;
  roomType: string | null;
  bedrooms: string | null;
  furnished: string | null;
  listingType: string | null;
};

function buildEmbedText(row: RawRow): string {
  const parts: string[] = [];
  if (row.title) parts.push(row.title);
  if (row.locationText) parts.push(`地点: ${row.locationText}`);
  if (row.rent) parts.push(`租金: ${row.rent}`);
  if (row.roomType) parts.push(`户型: ${row.roomType}`);
  if (row.bedrooms) parts.push(`卧室: ${row.bedrooms}`);
  if (row.furnished) parts.push(`家具: ${row.furnished}`);
  if (row.listingType) parts.push(`类型: ${row.listingType}`);
  parts.push(row.rawText);
  return parts.join("\n");
}

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
    SELECT id, title, "rawText", "locationText", rent, "roomType", bedrooms, furnished, "listingType"
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
    const texts = batch.map(buildEmbedText);

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
