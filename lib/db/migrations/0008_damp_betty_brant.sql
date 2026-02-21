-- Alter Shift.startTime from text to timestamptz (existing table).
-- Values that look like ISO date are cast; others become NULL.
ALTER TABLE "Shift"
  ALTER COLUMN "startTime" TYPE timestamptz
  USING (
    CASE
      WHEN "startTime" IS NOT NULL AND "startTime" ~ '^\d{4}-\d{2}-\d{2}'
      THEN "startTime"::timestamptz
      ELSE NULL
    END
  );
