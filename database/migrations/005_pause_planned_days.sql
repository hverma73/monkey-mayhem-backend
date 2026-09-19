-- =====================================================================
--  Migration 005 — optional planned pause length
-- ---------------------------------------------------------------------
--  Why: staff may want to record how many days a member intends to pause.
--  planned_days is optional: when set it drives the "resume by" date shown in
--  the UI and caps the days credited on resume (you can't get back more than
--  planned, or more than the plan's budget). NULL = open-ended (resume anytime,
--  credited the actual elapsed days). The real freeze credit is still computed
--  from elapsed time on resume.
--
--  REVIEW BEFORE RUNNING:
--    psql "$DATABASE_URL" -f database/migrations/005_pause_planned_days.sql
--  Re-running is safe (ADD COLUMN IF NOT EXISTS + guarded CHECK).
-- =====================================================================

BEGIN;

ALTER TABLE membership_pause ADD COLUMN IF NOT EXISTS planned_days INT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'membership_pause_planned_days_check') THEN
    ALTER TABLE membership_pause
      ADD CONSTRAINT membership_pause_planned_days_check
      CHECK (planned_days IS NULL OR planned_days > 0);
  END IF;
END $$;

COMMIT;
