-- Convert Shift.startTime from text to timestamptz for range queries and sorting.
-- Existing values that look like ISO date/time are cast; others become NULL.
ALTER TABLE "Shift"
  ALTER COLUMN "startTime" TYPE timestamptz
  USING (
    CASE
      WHEN "startTime" IS NOT NULL AND "startTime" ~ '^\d{4}-\d{2}-\d{2}'
      THEN "startTime"::timestamptz
      ELSE NULL
    END
  );
