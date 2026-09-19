-- =====================================================================
--  Migration 002 — payments & invoicing
-- ---------------------------------------------------------------------
--  Why: turn each membership period into an invoice (amount + registration
--  fee + discount) that can have many payment receipts, so the app can show
--  Payment History / Active / Inactive, edit payments, take part-payments,
--  and generate the invoice PDF. Existing data keeps working: every old
--  membership becomes a fully-paid invoice, and its amount_paid is migrated
--  into one payment receipt.
--
--  REVIEW BEFORE RUNNING. Run once against the live database, e.g.:
--    psql "$DATABASE_URL" -f database/migrations/002_payments.sql
--  Re-running is safe (IF NOT EXISTS / WHERE ... IS NULL / NOT EXISTS guards).
-- =====================================================================

BEGIN;

-- 1. Shared running number for invoice_no + re_no (interleaves like 60/61).
CREATE SEQUENCE IF NOT EXISTS billing_doc_seq START 1;

-- 2. Billing columns on the membership (= the invoice header).
ALTER TABLE membership ADD COLUMN IF NOT EXISTS invoice_no       INT;
ALTER TABLE membership ADD COLUMN IF NOT EXISTS amount           NUMERIC(10,2);
ALTER TABLE membership ADD COLUMN IF NOT EXISTS registration_fee NUMERIC(10,2) NOT NULL DEFAULT 0;
ALTER TABLE membership ADD COLUMN IF NOT EXISTS discount         NUMERIC(10,2) NOT NULL DEFAULT 0;
ALTER TABLE membership ADD COLUMN IF NOT EXISTS notes            TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'membership_money_check') THEN
    ALTER TABLE membership
      ADD CONSTRAINT membership_money_check
      CHECK ((amount IS NULL OR amount >= 0) AND registration_fee >= 0 AND discount >= 0);
  END IF;
END $$;

-- 3. Backfill amount from legacy amount_paid (fallback to the package price).
UPDATE membership ms
   SET amount = COALESCE(ms.amount_paid, p.price)
  FROM package p
 WHERE p.package_id = ms.package_id
   AND ms.amount IS NULL;

-- 4. Backfill invoice numbers for existing rows (oldest first), then make new
--    inserts auto-number from the same sequence so old flows keep working.
UPDATE membership SET invoice_no = nextval('billing_doc_seq')
 WHERE invoice_no IS NULL;
ALTER TABLE membership ALTER COLUMN invoice_no SET DEFAULT nextval('billing_doc_seq');

-- 5. Payment receipts (one membership : many payments).
CREATE TABLE IF NOT EXISTS payment (
    payment_id    SERIAL PRIMARY KEY,
    re_no         INT NOT NULL DEFAULT nextval('billing_doc_seq'),
    membership_id INT NOT NULL REFERENCES membership(id) ON DELETE CASCADE,
    member_id     INT NOT NULL REFERENCES member(member_id) ON DELETE CASCADE,
    paid_amount   NUMERIC(10,2) NOT NULL CHECK (paid_amount >= 0),
    pay_mode      TEXT NOT NULL DEFAULT 'Cash'
                    CHECK (pay_mode IN ('Cash','Card','UPI','Bank Transfer','Cheque','Other')),
    details       TEXT,
    executive     TEXT,                       -- staff name who took the payment
    paid_on       DATE NOT NULL DEFAULT CURRENT_DATE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_payment_member     ON payment (member_id);
CREATE INDEX IF NOT EXISTS idx_payment_membership ON payment (membership_id);
CREATE INDEX IF NOT EXISTS idx_payment_paid_on    ON payment (paid_on);

-- 6. Backfill a receipt for each historical membership that recorded money.
INSERT INTO payment (membership_id, member_id, paid_amount, pay_mode, details, paid_on)
SELECT ms.id, ms.member_id, ms.amount_paid, 'Cash', 'Imported from legacy amount_paid', ms.start_date
FROM membership ms
WHERE ms.amount_paid IS NOT NULL AND ms.amount_paid > 0
  AND NOT EXISTS (SELECT 1 FROM payment pm WHERE pm.membership_id = ms.id);

-- 7. Billing summary view — powers the Payments lists and the invoice.
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
    CASE WHEN ms.end_date >= CURRENT_DATE THEN 'Active' ELSE 'Inactive' END AS membership_status
FROM membership ms
JOIN member  m ON m.member_id  = ms.member_id
JOIN package p ON p.package_id = ms.package_id
LEFT JOIN LATERAL (
    SELECT COALESCE(SUM(pm.paid_amount),0) AS paid_amount
    FROM payment pm WHERE pm.membership_id = ms.id
) pay ON true;

-- 8. Refresh member_overview to expose paid_amount/balance from payments
--    (keeps the legacy amount_paid column for backward compatibility).
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
        WHEN ms.end_date IS NULL              THEN 'No Plan'
        WHEN ms.end_date >= CURRENT_DATE      THEN 'Active'
        ELSE 'Inactive'
    END                                                          AS status,
    -- New billing columns appended at the end (CREATE OR REPLACE VIEW can only
    -- add columns, never reorder/rename existing ones).
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
