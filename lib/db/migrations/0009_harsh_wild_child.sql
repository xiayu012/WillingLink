-- Add rentNumeric column: parsed monthly rent in USD (integer).
-- Values outside 100–15000 are treated as invalid and left NULL.
-- A follow-up backfill script populates this from the existing "rent" text column.
ALTER TABLE "XhsRentalListing" ADD COLUMN IF NOT EXISTS "rentNumeric" integer;
