-- XhsRentalListing：Dify / 自然语言检索与列表性能（pg_trgm + 常用等值列）
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS "XhsRentalListing_createdAt_id_idx"
  ON "XhsRentalListing" ("createdAt" DESC, "id" DESC);

CREATE INDEX IF NOT EXISTS "XhsRentalListing_title_trgm_idx"
  ON "XhsRentalListing" USING gin ("title" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "XhsRentalListing_rawText_trgm_idx"
  ON "XhsRentalListing" USING gin ("rawText" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "XhsRentalListing_locationText_trgm_idx"
  ON "XhsRentalListing" USING gin ("locationText" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "XhsRentalListing_propertyName_trgm_idx"
  ON "XhsRentalListing" USING gin ("propertyName" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "XhsRentalListing_listingType_idx"
  ON "XhsRentalListing" ("listingType");

CREATE INDEX IF NOT EXISTS "XhsRentalListing_bedrooms_idx"
  ON "XhsRentalListing" ("bedrooms");

CREATE INDEX IF NOT EXISTS "XhsRentalListing_bathrooms_idx"
  ON "XhsRentalListing" ("bathrooms");

CREATE INDEX IF NOT EXISTS "XhsRentalListing_roomType_idx"
  ON "XhsRentalListing" ("roomType");

CREATE INDEX IF NOT EXISTS "XhsRentalListing_furnished_idx"
  ON "XhsRentalListing" ("furnished");
