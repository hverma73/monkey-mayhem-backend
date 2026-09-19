-- =====================================================================
--  Migration 007 — data-integrity constraints (DRAFT — REVIEW BEFORE RUNNING)
-- ---------------------------------------------------------------------
--  Why: the API now validates these rules, but nothing at the DB level stops
--  a direct write (psql, a future endpoint, an import bug) from violating
--  them. Belt-and-braces the three invariants the money views depend on:
--    1. discount can't exceed the charge  → invoice totals can't go negative
--    2. a period can't end before it starts
--    3. a payment can't be dated in the (far) future → report buckets stay true
--
--  NOT VALID + VALIDATE two-step: NOT VALID enforces the rule for NEW writes
--  immediately without scanning existing rows; run the VALIDATE statements
--  after cleaning any violations the pre-check queries surface.
--
--  ⚠️  HUMAN REVIEW REQUIRED (org standard). Not applied automatically.
--  Run once, in order, after 006:
--    psql "$DATABASE_URL" -f database/migrations/007_constraints.sql
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 0. Pre-checks: list rows that would violate each rule. Clean these up
--    (or consciously accept them) BEFORE running the VALIDATE step below.
-- ---------------------------------------------------------------------
-- 0a. Discount exceeding the charge:
--   SELECT id, member_id, amount, registration_fee, discount FROM membership
--   WHERE discount > COALESCE(amount, 0) + registration_fee;
-- 0b. Periods ending before they start:
--   SELECT id, member_id, start_date, end_date FROM membership
--   WHERE end_date < start_date;
-- 0c. Future-dated receipts (tolerance: tomorrow, for timezone edges):
--   SELECT payment_id, member_id, paid_on FROM payment
--   WHERE paid_on > CURRENT_DATE + 1;

-- ---------------------------------------------------------------------
-- 1. Discount ≤ amount + registration_fee  (invoice total stays ≥ 0)
-- ---------------------------------------------------------------------
ALTER TABLE membership
  ADD CONSTRAINT membership_discount_within_charge
  CHECK (discount <= COALESCE(amount, 0) + registration_fee)
  NOT VALID;

-- ---------------------------------------------------------------------
-- 2. end_date ≥ start_date  (a period can't end before it starts)
-- ---------------------------------------------------------------------
ALTER TABLE membership
  ADD CONSTRAINT membership_dates_ordered
  CHECK (end_date >= start_date)
  NOT VALID;

-- ---------------------------------------------------------------------
-- 3. paid_on not in the future (CURRENT_DATE + 1 tolerance for client/server
--    timezone skew). Note: CURRENT_DATE in a CHECK is evaluated at write time
--    only — accepted here as a data-entry guard, not a temporal invariant.
-- ---------------------------------------------------------------------
ALTER TABLE payment
  ADD CONSTRAINT payment_paid_on_not_future
  CHECK (paid_on <= CURRENT_DATE + 1)
  NOT VALID;

COMMIT;

-- ---------------------------------------------------------------------
-- 4. After cleaning any pre-check violations, validate existing rows too
--    (each takes a brief SHARE UPDATE EXCLUSIVE lock; run off-peak):
-- ---------------------------------------------------------------------
-- ALTER TABLE membership VALIDATE CONSTRAINT membership_discount_within_charge;
-- ALTER TABLE membership VALIDATE CONSTRAINT membership_dates_ordered;
-- ALTER TABLE payment    VALIDATE CONSTRAINT payment_paid_on_not_future;
