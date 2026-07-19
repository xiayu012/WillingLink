/**
 * Dedup health check (read-only, except for one throwaway functional test row
 * that inserts + deletes itself). Run any time to verify:
 *   1. No duplicate sourceUrl / contentHash currently exist in any table.
 *   2. contentHash fill rate (should be 100%).
 *   3. The 3 partial UNIQUE indexes still exist.
 *   4. Live functional test: inserting the same content twice really does
 *      resolve to the same row (duplicate: true) instead of creating a copy.
 */
import { config } from "dotenv";

config({ path: ".env.local" });
if (process.env.POSTGRES_URL?.startsWith('"')) {
  process.env.POSTGRES_URL = process.env.POSTGRES_URL.slice(1, -1);
}

import { createHash } from "node:crypto";
import postgres from "postgres";

const client = postgres(process.env.POSTGRES_URL!);

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Standalone mirror of createXhsRentalListing's dedup logic (can't import
 * lib/db/queries.ts here — it has a `server-only` guard for Next.js).
 */
async function createListingForTest(sourceUrl: string, rawText: string) {
  const contentHash = sha256(rawText);
  const [row] = await client`
    INSERT INTO "XhsRentalListing" ("sourceUrl", "rawText", "contentHash", "createdAt")
    VALUES (${sourceUrl}, ${rawText}, ${contentHash}, now())
    ON CONFLICT DO NOTHING
    RETURNING id
  `;
  if (row) {
    return { id: row.id as string, duplicate: false };
  }
  const isPending = sourceUrl.startsWith("pending:");
  const [existing] = isPending
    ? await client`SELECT id FROM "XhsRentalListing" WHERE "contentHash" = ${contentHash} LIMIT 1`
    : await client`
        SELECT id FROM "XhsRentalListing"
        WHERE "sourceUrl" = ${sourceUrl} OR "contentHash" = ${contentHash}
        LIMIT 1
      `;
  return existing ? { id: existing.id as string, duplicate: true } : null;
}

const TABLES = [
  "XhsRentalListing",
  "XhsRentalWanted",
  "XhsRentalOther",
] as const;

async function checkDuplicates() {
  console.log("=== 1. 当前重复检查（应全部为 0）===");
  for (const table of TABLES) {
    const dupUrl = await client`
      SELECT "sourceUrl", COUNT(*) AS c FROM ${client(table)}
      WHERE "sourceUrl" NOT LIKE 'pending:%'
      GROUP BY "sourceUrl" HAVING COUNT(*) > 1
    `;
    const dupHash = await client`
      SELECT "contentHash", COUNT(*) AS c FROM ${client(table)}
      WHERE "contentHash" IS NOT NULL
      GROUP BY "contentHash" HAVING COUNT(*) > 1
    `;
    console.log(
      `  ${table}: sourceUrl重复组=${dupUrl.length}  contentHash重复组=${dupHash.length}`
    );
    if (dupUrl.length > 0) {
      console.log(
        "    重复的 sourceUrl:",
        dupUrl.map((r) => r.sourceUrl)
      );
    }
    if (dupHash.length > 0) {
      console.log(
        "    重复的 contentHash:",
        dupHash.map((r) => r.contentHash)
      );
    }
  }
}

async function checkFillRate() {
  console.log("\n=== 2. contentHash 填充率（应 100%）===");
  for (const table of TABLES) {
    const [row] = await client`
      SELECT COUNT(*) AS total, COUNT("contentHash") AS hashed
      FROM ${client(table)}
    `;
    console.log(`  ${table}: ${row.hashed}/${row.total} 已填充`);
  }
}

async function checkIndexes() {
  console.log("\n=== 3. 唯一索引检查 ===");
  const rows = await client`
    SELECT tablename, indexname FROM pg_indexes
    WHERE tablename IN ('XhsRentalListing', 'XhsRentalWanted', 'XhsRentalOther')
      AND indexname LIKE 'uq_%'
    ORDER BY tablename, indexname
  `;
  for (const row of rows) {
    console.log(`  ✓ ${row.tablename}.${row.indexname}`);
  }
  const expected = 6;
  console.log(
    rows.length === expected
      ? "  全部 6 个索引均存在"
      : `  ⚠ 期望 6 个索引，实际只找到 ${rows.length} 个`
  );
}

async function functionalTest() {
  console.log("\n=== 4. 实际功能测试：同一内容提交两次 ===");
  const marker = `__dedup_healthcheck__${Date.now()}`;
  const rawText = `【自动化去重测试，可安全忽略/删除】${marker}`;

  const first = await createListingForTest(`pending:${marker}`, rawText);
  const second = await createListingForTest(
    `pending:${marker}-second-submit`,
    rawText
  );

  const pass = Boolean(
    first && second && first.id === second.id && second.duplicate === true
  );
  console.log(`  第一次插入: id=${first?.id} duplicate=${first?.duplicate}`);
  console.log(
    `  第二次插入(同文本): id=${second?.id} duplicate=${second?.duplicate}`
  );
  console.log(pass ? "  ✅ 去重生效：第二次没有产生新行" : "  ❌ 去重未生效！");

  if (first?.id) {
    await client`DELETE FROM "XhsRentalListing" WHERE id = ${first.id}::uuid`;
    console.log("  （已清理测试数据）");
  }
  return pass;
}

async function main() {
  await checkDuplicates();
  await checkFillRate();
  await checkIndexes();
  const pass = await functionalTest();
  await client.end();
  if (!pass) {
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("❌", e.message);
  process.exit(1);
});
