-- ============================================================
-- 给 XhsRentalListing 加入地理编码缓存字段
-- 在 Neon 控制台执行一次即可（可重复执行）
-- ============================================================

ALTER TABLE "XhsRentalListing"
  ADD COLUMN IF NOT EXISTS "lat"        double precision,
  ADD COLUMN IF NOT EXISTS "lng"        double precision,
  ADD COLUMN IF NOT EXISTS "geocodedAt" timestamptz;
