-- =====================================================================
--  Migration 006 — stacked / upcoming membership periods
-- ---------------------------------------------------------------------
--  Why: adding a membership period while one is running now STACKS — the new
--  period abuts the furthest not-yet-expired end_date, so total coverage
--  extends and no paid time is lost (the stacking itself is in routes/members.js
--  addMembership; this migration only changes how reads describe a member who
--  has more than one period).
--
--  Changes (VIEWS + one index only — no data is rewritten):
--   1. membership_billing: 5-value membership_status (adds 'Upcoming' for a
--      period whose start_date is in the future) + a new period_phase column
--      ('past' | 'current' | 'upcoming') computed server-side so the frontend
--      never has to do timezone-sensitive date math.
--   2. member_overview: the per-member LATERAL now picks the period that best
--      represents the member TODAY — an open-paused period first (its end_date
--      is frozen and may sit in the past), else the period covering today, else
--      the soonest upcoming, else the most-recent past — instead of blindly the
--      max(end_date) (which after stacking is the queued upcoming period). This
--      fixes the roster showing the wrong package, the expiry watchlist hiding
--      members whose running plan lapses soon, and a paused member reading
--      'Active'. Two columns appended: upcoming_count and next_start_date.
--   3. A partial unique index enforcing at most ONE open pause per MEMBER (the
--      old index was per membership_id; stacking makes a per-member guard
--      necessary so a drifted pause can't be doubled up).
--
--  Coverage convention (unchanged from legacy): end_date is the abutting handoff
--  day; Active = end_date >= CURRENT_DATE; a stacked period starts ON the prior
--  end_date (see addMembership). Do NOT change >= to > here without also
--  changing the stacking anchor.
--
--  REVIEW BEFORE RUNNING (human DBA review required for migrations).
--    psql "$DATABASE_URL" -f database/migrations/006_stacked_periods.sql
--  Re-running is safe (DROP VIEW IF EXISTS / CREATE INDEX IF NOT EXISTS).
--  Nothing in the DB depends on these views (only app queries SELECT from them),
--  so they are rebuilt wholesale. database/schema.sql carries the same two view
--  bodies + index for fresh installs — keep them byte-identical.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1. At most one OPEN (unresumed) pause per member.
-- ---------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_open_pause_member
  ON membership_pause (member_id) WHERE resume_date IS NULL;

-- ---------------------------------------------------------------------
-- 2. membership_billing — one row per membership/invoice.
--    Adds 'Upcoming' to membership_status + appends period_phase.
-- ---------------------------------------------------------------------
DROP VIEW IF EXISTS membership_billing CASCADE;
CREATE VIEW membership_billing AS
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
    -- Appended last (server-computed phase the frontend buckets on).
    CASE
        WHEN ms.start_date > CURRENT_DATE THEN 'upcoming'
        WHEN ms.end_date  <  CURRENT_DATE THEN 'past'
        ELSE 'current'
    END                                                            AS period_phase
FROM membership ms
JOIN member  m ON m.member_id  = ms.member_id
JOIN package p ON p.package_id = ms.package_id
LEFT JOIN LATERAL (
    SELECT COALESCE(SUM(pm.paid_amount),0) AS paid_amount
    FROM payment pm WHERE pm.membership_id = ms.id
) pay ON true;

-- ---------------------------------------------------------------------
-- 3. member_overview — one row per member, describing them TODAY.
--    Picks open-paused → covering-today → soonest upcoming → most-recent past.
--    Appends upcoming_count + next_start_date.
-- ---------------------------------------------------------------------
DROP VIEW IF EXISTS member_overview CASCADE;
CREATE VIEW member_overview AS
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
    ms.amount_paid,                                              -- legacy
    (ms.end_date - CURRENT_DATE)                                 AS days_to_expiry,
    CASE
        WHEN ms.end_date IS NULL              THEN 'No Plan'
        WHEN EXISTS (SELECT 1 FROM membership_pause mp
                     WHERE mp.membership_id = ms.id AND mp.resume_date IS NULL) THEN 'Paused'
        WHEN ms.start_date > CURRENT_DATE     THEN 'Upcoming'
        WHEN ms.end_date  >= CURRENT_DATE     THEN 'Active'
        ELSE 'Inactive'
    END                                                          AS status,
    -- Billing columns (unchanged set/order; appended originally in migration 002).
    ms.invoice_no,
    ms.amount,
    ms.registration_fee,
    ms.discount,
    (COALESCE(ms.amount,0) + ms.registration_fee - ms.discount)    AS total_amount,
    COALESCE(pay.paid_amount, 0)                                   AS paid_amount,
    (COALESCE(ms.amount,0) + ms.registration_fee - ms.discount)
        - COALESCE(pay.paid_amount, 0)                             AS balance,
    -- New (appended last): how many periods are queued, and where a new stacked
    -- period would start (the furthest not-yet-expired end_date, else today).
    (SELECT count(*) FROM membership u
      WHERE u.member_id = m.member_id AND u.start_date > CURRENT_DATE)::int AS upcoming_count,
    COALESCE(
      (SELECT MAX(u.end_date) FROM membership u
        WHERE u.member_id = m.member_id AND u.end_date >= CURRENT_DATE),
      CURRENT_DATE
    )                                                              AS next_start_date
FROM member m
LEFT JOIN LATERAL (
    SELECT x.*
    FROM membership x
    WHERE x.member_id = m.member_id
    ORDER BY
      (EXISTS (SELECT 1 FROM membership_pause mp
               WHERE mp.membership_id = x.id AND mp.resume_date IS NULL)) DESC,  -- open pause wins
      (x.start_date <= CURRENT_DATE AND x.end_date >= CURRENT_DATE) DESC,        -- else covering today
      CASE WHEN x.start_date > CURRENT_DATE THEN x.start_date END ASC NULLS LAST,-- else soonest upcoming
      x.end_date DESC                                                           -- else most-recent past
    LIMIT 1
) ms ON true
LEFT JOIN package    p  ON p.package_id  = ms.package_id
LEFT JOIN office_use ou ON ou.member_id  = m.member_id
LEFT JOIN LATERAL (
    SELECT COALESCE(SUM(pm.paid_amount),0) AS paid_amount
    FROM payment pm WHERE pm.membership_id = ms.id
) pay ON true;

COMMIT;
