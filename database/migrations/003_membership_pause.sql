-- =====================================================================
--  Migration 003 — membership pause (freeze)
-- ---------------------------------------------------------------------
--  Why: let staff pause a member's plan (Cult.fit-style). The paused days
--  are added back to the plan (end_date moves out), so paid time isn't lost.
--  The pause-day budget depends on the plan length and is enforced in the API.
--  A membership reads as 'Paused' while today is inside an active pause window.
--
--  REVIEW BEFORE RUNNING. Run ONCE against the live database, e.g.:
--    psql "$DATABASE_URL" -f database/migrations/003_membership_pause.sql
--  Apply migrations in order and do NOT re-run this file after 004+ has been
--  applied: 004 drops pause_end (guards below skip those steps), and 006
--  upgrades both views, so the CREATE OR REPLACE VIEW statements here would
--  fail against the newer view shapes (Postgres can't drop view columns).
-- =====================================================================

BEGIN;

-- 1. Pause records (one membership : many pauses). pause_end is stored and
--    INCLUSIVE: pause_end = pause_start + (days - 1).
CREATE TABLE IF NOT EXISTS membership_pause (
    pause_id      SERIAL PRIMARY KEY,
    membership_id INT  NOT NULL REFERENCES membership(id)    ON DELETE CASCADE,
    member_id     INT  NOT NULL REFERENCES member(member_id) ON DELETE CASCADE,
    pause_start   DATE NOT NULL DEFAULT CURRENT_DATE,
    days          INT  NOT NULL CHECK (days > 0),
    pause_end     DATE NOT NULL,
    reason        TEXT,
    created_by    TEXT,                       -- staff name who paused
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The window constraint and index depend on pause_end, which migration 004
-- REMOVES (open-ended pauses). Guard on the column still existing so this file
-- stays truly idempotent even when re-run after 004 — without the guard a
-- re-run aborts on the dropped column.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'membership_pause' AND column_name = 'pause_end')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'membership_pause_window_check') THEN
    ALTER TABLE membership_pause
      ADD CONSTRAINT membership_pause_window_check
      CHECK (pause_end = pause_start + (days - 1));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_pause_membership ON membership_pause (membership_id);
CREATE INDEX IF NOT EXISTS idx_pause_member     ON membership_pause (member_id);
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'membership_pause' AND column_name = 'pause_end') THEN
    CREATE INDEX IF NOT EXISTS idx_pause_window ON membership_pause (membership_id, pause_start, pause_end);
  END IF;
END $$;

-- 2. Add a 'Paused' branch to both status views. Only the status CASE
--    expression changes (no columns added/reordered), so CREATE OR REPLACE
--    is legal.
CREATE OR REPLACE VIEW membership_billing AS
SELECT
    ms.id                                                          AS membership_id,
    ms.invoice_no,
    ms.member_id,
    m.full_name,
    m.mobile_no1,
    m.email,
    m.address,
    m.id_proof_no,
    ms.package_id,
    p.name                                                         AS package_name,
    p.duration_months,
    ms.start_date,
    ms.end_date,
    ms.amount,
    ms.registration_fee,
    ms.discount,
    (COALESCE(ms.amount,0) + ms.registration_fee - ms.discount)    AS total_amount,
    COALESCE(pay.paid_amount, 0)                                   AS paid_amount,
    (COALESCE(ms.amount,0) + ms.registration_fee - ms.discount)
        - COALESCE(pay.paid_amount, 0)                             AS balance,
    ms.notes,
    ms.created_at,
    CASE
        WHEN EXISTS (SELECT 1 FROM membership_pause mp
                     WHERE mp.membership_id = ms.id
                       AND CURRENT_DATE BETWEEN mp.pause_start AND mp.pause_end) THEN 'Paused'
        WHEN ms.end_date >= CURRENT_DATE THEN 'Active'
        ELSE 'Inactive'
    END                                                            AS membership_status
FROM membership ms
JOIN member  m ON m.member_id  = ms.member_id
JOIN package p ON p.package_id = ms.package_id
LEFT JOIN LATERAL (
    SELECT COALESCE(SUM(pm.paid_amount),0) AS paid_amount
    FROM payment pm WHERE pm.membership_id = ms.id
) pay ON true;

CREATE OR REPLACE VIEW member_overview AS
SELECT
    m.member_id,
    m.full_name,
    m.date_of_birth,
    CASE WHEN m.date_of_birth IS NULL THEN NULL
         ELSE date_part('year', age(m.date_of_birth))::int END   AS age,
    m.gender,
    m.email,
    m.mobile_no1,
    m.blood_group,
    m.photo_url,
    ou.membership_no,
    ou.batch,
    ou.trainer,
    ou.date_of_joining,
    ms.start_date,
    ms.end_date,
    p.package_id,
    p.name            AS package_name,
    p.duration_months,
    ms.amount_paid,
    (ms.end_date - CURRENT_DATE)                                 AS days_to_expiry,
    CASE
        WHEN ms.end_date IS NULL          THEN 'No Plan'
        WHEN EXISTS (SELECT 1 FROM membership_pause mp
                     WHERE mp.membership_id = ms.id
                       AND CURRENT_DATE BETWEEN mp.pause_start AND mp.pause_end) THEN 'Paused'
        WHEN ms.end_date >= CURRENT_DATE  THEN 'Active'
        ELSE 'Inactive'
    END                                                          AS status,
    ms.invoice_no,
    ms.amount,
    ms.registration_fee,
    ms.discount,
    (COALESCE(ms.amount,0) + ms.registration_fee - ms.discount)    AS total_amount,
    COALESCE(pay.paid_amount, 0)                                   AS paid_amount,
    (COALESCE(ms.amount,0) + ms.registration_fee - ms.discount)
        - COALESCE(pay.paid_amount, 0)                             AS balance
FROM member m
LEFT JOIN LATERAL (
    SELECT * FROM membership x
    WHERE x.member_id = m.member_id
    ORDER BY x.end_date DESC
    LIMIT 1
) ms ON true
LEFT JOIN package    p  ON p.package_id  = ms.package_id
LEFT JOIN office_use ou ON ou.member_id  = m.member_id
LEFT JOIN LATERAL (
    SELECT COALESCE(SUM(pm.paid_amount),0) AS paid_amount
    FROM payment pm WHERE pm.membership_id = ms.id
) pay ON true;

COMMIT;
