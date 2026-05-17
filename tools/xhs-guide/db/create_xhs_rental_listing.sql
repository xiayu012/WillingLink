-- ============================================================
-- XhsRentalListing：租房场景15 个业务字段 + id / createdAt
-- 在 Neon 控制台整段执行一次即可（可重复执行：ADD COLUMN 为 IF NOT EXISTS）
-- ============================================================

-- 新库：直接建完整表（列名与 Drizzle schema 一致，camelCase + 双引号）
CREATE TABLE IF NOT EXISTS "XhsRentalListing" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "sourceUrl" text NOT NULL,
  "title" text,
  "rawText" text NOT NULL,
  "rent" text,
  "deposit" text,
  "availableFrom" text,
  "leaseEndDate" text,
  "listingType" text,
  "bedrooms" text,
  "bathrooms" text,
  "roomType" text,
  "propertyName" text,
  "locationText" text,
  "furnished" text,
  "contactMethod" text,
  "imageUrls" jsonb DEFAULT '[]'::jsonb,
  "createdAt" timestamptz NOT NULL
);

-- 旧库：若仍是 pageUrl 列名，改名为 sourceUrl（与现版 API 一致）
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'XhsRentalListing'
      AND column_name = 'pageUrl'
  ) THEN
    ALTER TABLE "XhsRentalListing" RENAME COLUMN "pageUrl" TO "sourceUrl";
  END IF;
END $$;

-- 旧库：逐列补齐（新库已含下列列时不会报错）
ALTER TABLE "XhsRentalListing" ADD COLUMN IF NOT EXISTS "title" text;
ALTER TABLE "XhsRentalListing" ADD COLUMN IF NOT EXISTS "rent" text;
ALTER TABLE "XhsRentalListing" ADD COLUMN IF NOT EXISTS "deposit" text;
ALTER TABLE "XhsRentalListing" ADD COLUMN IF NOT EXISTS "availableFrom" text;
ALTER TABLE "XhsRentalListing" ADD COLUMN IF NOT EXISTS "leaseEndDate" text;
ALTER TABLE "XhsRentalListing" ADD COLUMN IF NOT EXISTS "listingType" text;
ALTER TABLE "XhsRentalListing" ADD COLUMN IF NOT EXISTS "bedrooms" text;
ALTER TABLE "XhsRentalListing" ADD COLUMN IF NOT EXISTS "bathrooms" text;
ALTER TABLE "XhsRentalListing" ADD COLUMN IF NOT EXISTS "roomType" text;
ALTER TABLE "XhsRentalListing" ADD COLUMN IF NOT EXISTS "propertyName" text;
ALTER TABLE "XhsRentalListing" ADD COLUMN IF NOT EXISTS "locationText" text;
ALTER TABLE "XhsRentalListing" ADD COLUMN IF NOT EXISTS "furnished" text;
ALTER TABLE "XhsRentalListing" ADD COLUMN IF NOT EXISTS "contactMethod" text;
ALTER TABLE "XhsRentalListing" ADD COLUMN IF NOT EXISTS "imageUrls" jsonb DEFAULT '[]'::jsonb;

-- 历史遗留 summary 列（若存在可删）
-- ALTER TABLE "XhsRentalListing" DROP COLUMN IF EXISTS "summary";
