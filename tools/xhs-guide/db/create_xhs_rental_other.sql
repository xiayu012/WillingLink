-- XhsRentalOther：经验分享、攻略、科普等非交易帖
CREATE TABLE IF NOT EXISTS "XhsRentalOther" (
  "id"          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "sourceUrl"   TEXT NOT NULL DEFAULT '',
  "rawText"     TEXT NOT NULL,
  "title"       TEXT,
  "aiReason"    TEXT,
  "imageUrls"   JSONB,
  "postedAt"    TIMESTAMPTZ,
  "createdAt"   TIMESTAMPTZ NOT NULL DEFAULT now()
);
