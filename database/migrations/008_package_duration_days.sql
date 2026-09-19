-- 008: day-based package durations.
-- The Custom Package Plan page now creates plans by DAYS (10-day trial,
-- 45 days, ...) instead of months. Existing month-based packages are
-- untouched: a package carries EXACTLY ONE of duration_months / duration_days,
-- and every end_date computation prefers days when present.
--
-- Run manually after review (like the other migrations):
--   psql "$DATABASE_URL" -f database/migrations/008_package_duration_days.sql

BEGIN;

ALTER TABLE package ALTER COLUMN duration_months DROP NOT NULL;

ALTER TABLE package
    ADD COLUMN duration_days INT CHECK (duration_days > 0);

-- Exactly one duration unit per package. (The old duration_months > 0 CHECK
-- still applies when months is set; NULL passes it.)
ALTER TABLE package
    ADD CONSTRAINT package_one_duration_check
    CHECK (num_nonnulls(duration_months, duration_days) = 1);

-- membership_billing feeds the pause-budget lookup (routes/members.js
-- pauseInfoFor), which now needs the day-based length too. CREATE OR REPLACE
-- VIEW may only APPEND columns, so p.duration_days goes at the very end.
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
        WHEN ms.start_date > CURRENT_DATE THEN 'Upcoming'
        WHEN ms.end_date  >= CURRENT_DATE THEN 'Active'
        ELSE 'Inactive'
    END                                                            AS membership_status,
    CASE
        WHEN ms.start_date > CURRENT_DATE THEN 'upcoming'
        WHEN ms.end_date  <  CURRENT_DATE THEN 'past'
        ELSE 'current'
    END                                                            AS period_phase,
    -- Appended (this migration): day-based plan length (NULL on month plans).
    p.duration_days
FROM membership ms
JOIN member  m ON m.member_id  = ms.member_id
JOIN package p ON p.package_id = ms.package_id
LEFT JOIN LATERAL (
    SELECT COALESCE(SUM(pm.paid_amount),0) AS paid_amount
    FROM payment pm WHERE pm.membership_id = ms.id
) pay ON true;

COMMIT;
