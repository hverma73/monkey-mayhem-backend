-- =====================================================================
--  Fix 001 — re-date receipts created by an Excel member import
--            (DRAFT — REVIEW BEFORE RUNNING)
-- ---------------------------------------------------------------------
--  Why: before the import fix in routes/upload.js, every imported member
--  with a package and a blank "Amount Paid" got a full-price Cash receipt
--  dated the UPLOAD day (payment.paid_on defaulted to CURRENT_DATE). A
--  migration of existing members therefore booked months of past fees as
--  that one day's takings, inflating the dashboard and payments reports.
--  This moves each such receipt to its period's start date — the same date
--  the fixed importer now uses (LEAST(start_date, CURRENT_DATE)). Amounts
--  are NOT changed; correct real amounts per member in the Payments tab.
--
--  Scope: the importer wrote each row's member, membership and receipt in
--  ONE transaction, so all three share the same created_at (now() is fixed
--  per transaction). Requiring that equality excludes every later desk
--  payment / renewal for an imported member. Also required: the importing
--  staff member, Cash, no details text (the old importer never set one; ''
--  covers a receipt since edited in the Payments tab), the import window,
--  and a receipt dated after its period's start. A walk-in added through the
--  Add Member form INSIDE the window would look the same — keep the
--  window tight to the import burst and check the preview's created_at.
--
--  ⚠️  HUMAN REVIEW REQUIRED (org standard). Not applied automatically.
--  1. Find the import burst (read-only) — the minutes with many receipts:
--       SELECT p.executive, date_trunc('minute', m.created_at) AS minute, count(*)
--       FROM payment p
--       JOIN membership ms ON ms.id = p.membership_id
--       JOIN member m ON m.member_id = p.member_id
--       WHERE p.created_at = m.created_at AND ms.created_at = m.created_at
--         AND p.pay_mode = 'Cash' AND COALESCE(p.details, '') = ''
--       GROUP BY 1, 2 ORDER BY 2 DESC LIMIT 30;
--  2. Edit the three values in import_config below with that burst's
--     executive, first minute, and last minute (+1 minute at the end), then
--     run this whole file in pgAdmin or the Supabase SQL Editor.
--  3. Check the preview: the count should match the import's receipts (for
--     the Sep-2026 import: at most 91 — members added with a package), and
--     no row should be a walk-in. The script ends in ROLLBACK; change the
--     last line to COMMIT and re-run to apply. The old date is kept in
--     payment.details for audit.
-- =====================================================================

BEGIN;

-- These values are deliberately ordinary SQL so this draft works in pgAdmin
-- and Supabase SQL Editor as well as psql. Replace them after reviewing the
-- read-only burst query above; do not widen the window unnecessarily.
CREATE TEMP TABLE import_config ON COMMIT DROP AS
SELECT 'Admin'::text AS executive,
       '2026-09-27 10:00+05:30'::timestamptz AS from_ts,
       '2026-09-27 10:06+05:30'::timestamptz AS to_ts;

CREATE TEMP TABLE import_receipt ON COMMIT DROP AS
SELECT p.payment_id,
       p.re_no,
       m.full_name,
       pk.name                               AS package_name,
       m.created_at,
       ms.start_date,
       p.paid_on                             AS old_paid_on,
       LEAST(ms.start_date, p.paid_on)       AS new_paid_on,
       p.paid_amount
FROM payment p
JOIN membership ms ON ms.id = p.membership_id
JOIN member     m  ON m.member_id = p.member_id
JOIN package    pk ON pk.package_id = ms.package_id
JOIN import_config c ON true
WHERE p.executive  = c.executive
  AND p.pay_mode   = 'Cash'
  AND COALESCE(p.details, '') = ''
  AND m.created_at BETWEEN c.from_ts AND c.to_ts
  AND ms.created_at = m.created_at
  AND p.created_at  = m.created_at
  AND p.paid_on > ms.start_date;

-- Preview: every receipt that will move, in import order.
SELECT * FROM import_receipt ORDER BY created_at, payment_id;

SELECT count(*) AS receipts, sum(paid_amount) AS amount_moved_off_import_day
FROM import_receipt;

UPDATE payment p
SET    paid_on = ir.new_paid_on,
       details = 'Excel import (re-dated from ' || ir.old_paid_on || ')'
FROM   import_receipt ir
WHERE  p.payment_id = ir.payment_id;

ROLLBACK;
