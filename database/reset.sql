-- =====================================================================
--  ⚠️  DESTRUCTIVE — DEV DATA RESET  ⚠️
--  Monkey Mayhem Fight Club
-- ---------------------------------------------------------------------
--  Wipes ALL member-facing data (members, memberships, payments, pauses,
--  emergency contacts, guardians, office_use) and restarts every id + the
--  invoice/receipt numbering at 1.
--
--  KEEPS:  package (the plan price list, incl. custom plans) and app_user
--          (login accounts — you will NOT be locked out).
--
--  This is for wiping test data on a DEV database. It is NOT a migration and
--  must NEVER be run against production. There is no undo.
--
--  How to run:
--    1. Back it up first (from a terminal, not psql):
--         pg_dump "$DATABASE_URL" > monkey_mayhem_backup_$(date +%F).sql
--    2. Then apply this file:
--         psql "$DATABASE_URL" -f database/reset.sql
--    3. Refresh the app — every chip/report reads zero, ids start at 1.
-- =====================================================================

BEGIN;

-- Members are the root of the FK graph: emergency_contact, guardian,
-- membership, membership_pause, office_use and payment all reference them, so
-- CASCADE clears the whole tree in one shot. RESTART IDENTITY resets the SERIAL
-- id counters (member_id, membership.id, payment_id, …) back to 1.
TRUNCATE TABLE member RESTART IDENTITY CASCADE;

-- invoice_no / re_no draw from a standalone sequence (not a SERIAL column), so
-- RESTART IDENTITY above doesn't reset it — do it explicitly.
ALTER SEQUENCE billing_doc_seq RESTART WITH 1;

COMMIT;

-- ---------------------------------------------------------------------
--  OPTIONAL — uncomment ONE of the blocks below if you also want to
--  reset the plan catalogue. Safe only AFTER the TRUNCATE above (nothing
--  references package once memberships are gone).
-- ---------------------------------------------------------------------

-- A) Drop custom/added plans, keep just the original four:
-- DELETE FROM package WHERE name NOT IN ('1 Month','3 Months','6 Months','1 Year');

-- B) Full clean slate — wipe the catalogue and re-seed the original four:
-- BEGIN;
-- TRUNCATE TABLE package RESTART IDENTITY CASCADE;
-- INSERT INTO package (name, duration_months, price, gender) VALUES
--   ('1 Month',  1,  3500.00, 'All'),
--   ('3 Months', 3,  9000.00, 'All'),
--   ('6 Months', 6, 18000.00, 'All'),
--   ('1 Year',  12, 25000.00, 'All');
-- COMMIT;
