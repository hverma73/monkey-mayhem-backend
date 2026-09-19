-- =====================================================================
--  Migration 005 — remove the staff/admin role
-- ---------------------------------------------------------------------
--  Why: the two-tier role system (admin vs staff) is gone. No route ever
--  enforced permissions on it, so the column was only a label. Logins are
--  now a single, undifferentiated kind of account.
--
--  REVIEW BEFORE RUNNING. Run once against the live database, e.g.:
--    psql "$DATABASE_URL" -f database/migrations/005_remove_role.sql
--  Re-running is safe (IF EXISTS guard).
-- =====================================================================
ALTER TABLE app_user DROP CONSTRAINT IF EXISTS app_user_role_check;
ALTER TABLE app_user DROP COLUMN IF EXISTS role;
