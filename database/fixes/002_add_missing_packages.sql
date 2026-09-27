-- =====================================================================
--  Fix 002 — add the plans the Sep-2026 member import could not find
--            (DRAFT — REVIEW BEFORE RUNNING)
-- ---------------------------------------------------------------------
--  Why: 16 rows of the member import failed with 'Unknown package' because
--  these plans did not exist. They are created with calendar-month
--  durations, like '1 Month' / '3 Months' / '1 Year' (the Custom Package
--  Plan screen can only create day-based plans). Prices are the unisex
--  defaults; the '1 Month Premium' price is an ASSUMPTION — change any
--  price below before running if the gym charges differently.
--  ('1 Month Female' is not created: it is the same plan as
--  '1 Month Women' — change that cell in the sheet instead.)
--
--  Safe to re-run: a plan is skipped when one with the same name already
--  exists, ignoring case and spacing (the way the importer matches names).
--  An existing plan that is INACTIVE is not reactivated — check the final
--  SELECT: every row must show is_active = t, or the import still fails.
--
--  ⚠️  HUMAN REVIEW REQUIRED (org standard). Not applied automatically.
--    psql "$DATABASE_URL" -f database/fixes/002_add_missing_packages.sql
-- =====================================================================

BEGIN;

INSERT INTO package (name, duration_months, price, gender)
SELECT v.name, v.duration_months, v.price, v.gender
FROM (VALUES
    ('1 Month Women',    1,  3500.00, 'Female'),
    ('3 Months Women',   3,  9000.00, 'Female'),
    ('1 Year Women',    12, 25000.00, 'Female'),
    ('1 Month Premium',  1,  3500.00, 'All')
) AS v(name, duration_months, price, gender)
WHERE NOT EXISTS (
    SELECT 1 FROM package p
    WHERE lower(regexp_replace(btrim(p.name), '\s+', ' ', 'g')) = lower(v.name)
);

-- Result: all four must be listed with is_active = t.
SELECT package_id, name, duration_months, duration_days, price, gender, is_active
FROM package
WHERE lower(regexp_replace(btrim(name), '\s+', ' ', 'g'))
      IN ('1 month women', '3 months women', '1 year women', '1 month premium')
ORDER BY package_id;

COMMIT;
