-- 在 Neon 控制台或 psql 里执行一次即可建表（不跑 Drizzle migration）
CREATE TABLE IF NOT EXISTS "XhsRentalListing" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "pageUrl" text NOT NULL,
  "rawText" text NOT NULL,
  "createdAt" timestamptz NOT NULL
);

-- 若你之前用旧版建过带 summary 的表，可再执行一行去掉多余列：
-- ALTER TABLE "XhsRentalListing" DROP COLUMN IF EXISTS "summary";
