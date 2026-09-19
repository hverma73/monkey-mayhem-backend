-- =====================================================================
--  Migration 001 — add a gender dimension to membership packages
-- ---------------------------------------------------------------------
--  Why: the "Custom Package Plan" screen lets staff pick a gender and see
--  the packages built for that gender. 'All' means unisex (offered to
--  everyone). Existing packages keep working — they default to 'All'.
--
--  REVIEW BEFORE RUNNING. Run once against the live database, e.g.:
--    psql "$DATABASE_URL" -f database/migrations/001_package_gender.sql
--  Re-running is safe (IF NOT EXISTS / ON CONFLICT guards below).
-- =====================================================================

BEGIN;

-- 1. The new column. NOT NULL with a default backfills existing rows to 'All'.
ALTER TABLE package
  ADD COLUMN IF NOT EXISTS gender TEXT NOT NULL DEFAULT 'All';

-- 2. Constrain the allowed values (added separately so the column add above
--    stays compatible with older Postgres; skipped if it already exists).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'package_gender_check'
  ) THEN
    ALTER TABLE package
      ADD CONSTRAINT package_gender_check
      CHECK (gender IN ('Male','Female','Other','All'));
  END IF;
END $$;

-- 3. OPTIONAL example gender-specific plans so the new screen has something
--    distinct to filter on. Disabled by default: these would also appear in
--    the member form's package dropdown (which is not gender-filtered), so
--    only uncomment if you want gender-specific plans offered gym-wide.
-- INSERT INTO package (name, duration_months, price, gender) VALUES
--     ('Ladies 1 Month',  1, 3000.00, 'Female'),
--     ('Ladies 3 Months', 3, 7500.00, 'Female')
-- ON CONFLICT (name) DO NOTHING;

COMMIT;
