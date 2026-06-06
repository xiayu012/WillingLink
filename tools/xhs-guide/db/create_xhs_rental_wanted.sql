-- ============================================================
-- XhsRentalWanted：租客求租帖（租客视角，找房源）
-- 在 Neon 控制台整段执行一次即可（可重复执行：ADD COLUMN 为 IF NOT EXISTS）
-- ============================================================

CREATE TABLE IF NOT EXISTS "XhsRentalWanted" (
  "id"                 uuid        PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "sourceUrl"          text        NOT NULL,
  "title"              text,
  "rawText"            text        NOT NULL,
  "budgetText"         text,
  "budgetMin"          text,
  "budgetMax"          text,
  "preferredLocations" text,
  "moveInDate"         text,
  "leaseDuration"      text,
  "wantedType"         text,
  "bedrooms"           text,
  "bathrooms"          text,
  "roomType"           text,
  "furnished"          text,
  "pets"               text,
  "occupation"         text,
  "householdSize"      text,
  "gender"             text,
  "requirements"       text,
  "contactMethod"      text,
  "imageUrls"          jsonb       DEFAULT '[]'::jsonb,
  "aiConfidence"       text,
  "aiReason"           text,
  "postedAt"           timestamptz,
  "createdAt"          timestamptz NOT NULL
);

ALTER TABLE "XhsRentalWanted" ADD COLUMN IF NOT EXISTS "budgetText"         text;
ALTER TABLE "XhsRentalWanted" ADD COLUMN IF NOT EXISTS "budgetMin"          text;
ALTER TABLE "XhsRentalWanted" ADD COLUMN IF NOT EXISTS "budgetMax"          text;
ALTER TABLE "XhsRentalWanted" ADD COLUMN IF NOT EXISTS "preferredLocations" text;
ALTER TABLE "XhsRentalWanted" ADD COLUMN IF NOT EXISTS "moveInDate"         text;
ALTER TABLE "XhsRentalWanted" ADD COLUMN IF NOT EXISTS "leaseDuration"      text;
ALTER TABLE "XhsRentalWanted" ADD COLUMN IF NOT EXISTS "wantedType"         text;
ALTER TABLE "XhsRentalWanted" ADD COLUMN IF NOT EXISTS "bedrooms"           text;
ALTER TABLE "XhsRentalWanted" ADD COLUMN IF NOT EXISTS "bathrooms"          text;
ALTER TABLE "XhsRentalWanted" ADD COLUMN IF NOT EXISTS "roomType"           text;
ALTER TABLE "XhsRentalWanted" ADD COLUMN IF NOT EXISTS "furnished"          text;
ALTER TABLE "XhsRentalWanted" ADD COLUMN IF NOT EXISTS "pets"               text;
ALTER TABLE "XhsRentalWanted" ADD COLUMN IF NOT EXISTS "occupation"         text;
ALTER TABLE "XhsRentalWanted" ADD COLUMN IF NOT EXISTS "householdSize"      text;
ALTER TABLE "XhsRentalWanted" ADD COLUMN IF NOT EXISTS "gender"             text;
ALTER TABLE "XhsRentalWanted" ADD COLUMN IF NOT EXISTS "requirements"       text;
ALTER TABLE "XhsRentalWanted" ADD COLUMN IF NOT EXISTS "contactMethod"      text;
ALTER TABLE "XhsRentalWanted" ADD COLUMN IF NOT EXISTS "imageUrls"          jsonb DEFAULT '[]'::jsonb;
ALTER TABLE "XhsRentalWanted" ADD COLUMN IF NOT EXISTS "aiConfidence"       text;
ALTER TABLE "XhsRentalWanted" ADD COLUMN IF NOT EXISTS "aiReason"           text;
ALTER TABLE "XhsRentalWanted" ADD COLUMN IF NOT EXISTS "postedAt"           timestamptz;
