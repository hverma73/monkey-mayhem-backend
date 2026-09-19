-- =====================================================================
--  Migration 004 — interactive pause / resume
-- ---------------------------------------------------------------------
--  Why: migration 003 modelled a pause as a fixed N-day block that extended
--  end_date immediately. The desired behaviour is open-ended: staff PAUSE a
--  membership now (it freezes, no preset length), then RESUME later — at which
--  point the days it was frozen are added back to end_date. So a pause row is
--  now { pause_start, resume_date (NULL = still frozen), days (set on resume) }.
--
--  REVIEW BEFORE RUNNING. Run once:
--    psql "$DATABASE_URL" -f database/migrations/004_pause_resume.sql
--  Re-running is safe (IF EXISTS / IF NOT EXISTS guards).
-- =====================================================================

BEGIN;

-- 1. Loosen the old fixed-window shape.
ALTER TABLE membership_pause DROP CONSTRAINT IF EXISTS membership_pause_window_check;
ALTER TABLE membership_pause ADD COLUMN IF NOT EXISTS resume_date DATE; -- NULL = currently paused
ALTER TABLE membership_pause ALTER COLUMN days DROP NOT NULL;            -- set on resume

-- 2. Repoint both views' 'Paused' branch to "has an OPEN pause" (resume_date
--    IS NULL) instead of a date window. Replace BEFORE dropping pause_end,
--    since the old definitions reference that column.
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
                     WHERE mp.membership_id = ms.id AND mp.resume_date IS NULL) THEN 'Paused'
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
                     WHERE mp.membership_id = ms.id AND mp.resume_date IS NULL) THEN 'Paused'
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

-- 3. Now drop the obsolete fixed-window column + its index.
DROP INDEX IF EXISTS idx_pause_window;
ALTER TABLE membership_pause DROP COLUMN IF EXISTS pause_end;

-- 4. At most one OPEN pause per membership (can't pause twice without resuming).
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_open_pause
    ON membership_pause (membership_id) WHERE resume_date IS NULL;

COMMIT;
