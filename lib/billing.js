// Pure billing helpers — no DB, no I/O — so they can be unit-tested with
// `node --test`. The database views (membership_billing) are the authority for
// reads; these mirror the same math for request validation and assembled
// responses, and pin the contract in tests.

export const PAY_MODES = ['Cash', 'Card', 'UPI', 'Bank Transfer', 'Cheque', 'Other'];

// Money is NUMERIC(10,2) in Postgres (returned as strings by pg). Round to 2dp
// after any arithmetic to avoid binary-float drift.
export function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

// Gross-of-payments total for an invoice (one membership period).
export function computeTotal({ amount = 0, registrationFee = 0, discount = 0 } = {}) {
  return round2((Number(amount) || 0) + (Number(registrationFee) || 0) - (Number(discount) || 0));
}

// Sum of receipts against an invoice. Accepts rows with `paid_amount`.
export function sumPayments(payments = []) {
  return round2((payments || []).reduce((acc, p) => acc + (Number(p?.paid_amount) || 0), 0));
}

// Outstanding balance = total − paid.
export function computeBalance({ amount, registrationFee, discount, paidAmount = 0 } = {}) {
  return round2(computeTotal({ amount, registrationFee, discount }) - (Number(paidAmount) || 0));
}

// --- validation -----------------------------------------------------------
// Each validator returns { ok: true } or { ok: false, error: '<message>' }.

function isNonNegativeNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0;
}

// A payment recorded against an existing membership.
export function validatePayment({ paid_amount, pay_mode, paid_on } = {}) {
  if (!isNonNegativeNumber(paid_amount)) {
    return { ok: false, error: 'Paid amount must be 0 or more.' };
  }
  if (pay_mode != null && pay_mode !== '' && !PAY_MODES.includes(pay_mode)) {
    return { ok: false, error: 'Invalid pay mode.' };
  }
  if (paid_on != null && paid_on !== '' && Number.isNaN(new Date(paid_on).getTime())) {
    return { ok: false, error: 'Invalid payment date.' };
  }
  return { ok: true };
}

// Sanity bound on a receipt relative to its invoice: a payment wildly larger
// than the invoice's total charge is almost certainly a typo (₹1,000,000 keyed
// against a ₹3,500 plan) and would flow into every report as a giant credit.
// Genuine overpayments/credits stay legal — only >10× the total is blocked.
// A missing/zero total (no charge recorded) skips the check.
export function validatePaymentBound({ paid_amount, total_amount } = {}) {
  const total = Number(total_amount);
  const paid = Number(paid_amount) || 0;
  if (Number.isFinite(total) && total > 0 && paid > total * 10) {
    return {
      ok: false,
      error: `Paid amount is more than 10× this invoice's total — that looks like a typo. Split it across the right invoices or correct the amount.`,
    };
  }
  return { ok: true };
}

// Optimistic-concurrency check for "settle the pending balance". The client
// sends the balance it displayed (expected); the server compares it to the
// freshly-read current balance. If they differ — someone recorded a payment
// first, or the page was stale — it's a conflict: the caller must refresh
// rather than overpay the invoice into a phantom credit. A blank/absent
// expectation means "no check" (the ordinary add-payment path, where an
// intentional overpayment/credit is allowed). Tolerates 2dp float noise.
export function expectedBalanceConflict(expected, current, eps = 0.005) {
  if (expected == null || expected === '') return false;   // no expectation → no check
  if (current == null || current === '') return false;     // can't read current → let other guards handle it
  const e = Number(expected);
  const c = Number(current);
  if (!Number.isFinite(e) || !Number.isFinite(c)) return false;
  return Math.abs(e - c) > eps;
}

// The discount can never exceed what's being charged (amount + registration
// fee) — otherwise the invoice total goes negative and reads as a bogus
// "Credit" everywhere. Callers pass the RESOLVED amount (explicit value or the
// plan's list price).
export function validateDiscount({ amount = 0, registration_fee = 0, discount = 0 } = {}) {
  const gross = (Number(amount) || 0) + (Number(registration_fee) || 0);
  if ((Number(discount) || 0) > gross) {
    return { ok: false, error: 'Discount cannot exceed the amount plus registration fee.' };
  }
  return { ok: true };
}

// --- membership pause ------------------------------------------------------
// Pause-day budget per plan length (Cult.fit-style). Non-standard durations
// scale at ~5 days/month (min 7); unknown/garbage durations get no budget.
const PAUSE_BUDGET = { 1: 7, 3: 15, 6: 30, 12: 60 };
export function pauseBudgetForMonths(months) {
  const m = Number(months);
  if (Object.hasOwn(PAUSE_BUDGET, m)) return PAUSE_BUDGET[m];
  if (!Number.isFinite(m) || m <= 0) return 0;
  return Math.max(7, Math.round(m * 5));
}

// A package carries EXACTLY ONE of duration_months / duration_days (custom
// plans are day-based since migration 008). Day plans scale at the same
// ~5 days per 30 — but the 7-day floor only applies from a month up, so a
// 10-day trial gets 2 pause days, not 7 of its own 10.
export function pauseBudgetForPlan({ duration_months, duration_days } = {}) {
  const d = Number(duration_days);
  if (Number.isFinite(d) && d > 0) {
    const scaled = Math.round((d * 5) / 30);
    return d >= 30 ? Math.max(7, scaled) : scaled;
  }
  return pauseBudgetForMonths(duration_months);
}

// Can we OPEN a pause now? `remaining` = budget − days already used by
// resumed pauses. Only an Active membership with budget left can be paused.
// `plannedDays` is optional (the intended pause length); if given it must be a
// positive whole number within the remaining budget.
export function validatePauseStart({ membershipStatus, remaining, plannedDays } = {}) {
  if (membershipStatus === 'Paused') {
    return { ok: false, error: 'Membership is already paused.' };
  }
  if (membershipStatus !== 'Active') {
    return { ok: false, error: 'Only an active membership can be paused.' };
  }
  const rem = Number(remaining);
  if (!Number.isFinite(rem) || rem <= 0) {
    return { ok: false, error: 'No pause days remaining for this plan.' };
  }
  if (plannedDays != null && plannedDays !== '') {
    const pd = Number(plannedDays);
    if (!Number.isInteger(pd) || pd <= 0) {
      return { ok: false, error: 'Planned days must be a whole number greater than 0.' };
    }
    if (pd > rem) {
      return { ok: false, error: `Only ${rem} pause day(s) remaining.` };
    }
  }
  return { ok: true };
}

// Can we RESUME? There must be an open pause (status 'Paused').
export function validateResume({ membershipStatus } = {}) {
  if (membershipStatus !== 'Paused') {
    return { ok: false, error: 'Membership is not paused.' };
  }
  return { ok: true };
}

// Frozen days to add back on resume: days elapsed since pause_start, never
// negative and never more than the remaining budget.
export function cappedPauseDays(elapsedDays, remaining) {
  const e = Math.max(0, Math.floor(Number(elapsedDays) || 0));
  const r = Math.max(0, Math.floor(Number(remaining) || 0));
  return Math.min(e, r);
}

// --- membership periods: stacking + phase classification ------------------
// Coverage convention (matches the legacy renew + the SQL views):
//   end_date is the ABUTTING handoff day. A period covers [start_date, end_date]
//   inclusively, and the next stacked period starts ON end_date (no +1 gap, no
//   double-billed day beyond the one-day touch that renew-on-expiry always had).
//   So Active = end_date >= today, and a queued period's start = MAX(end_date)
//   of the member's not-yet-expired periods.

// Normalise a Date or a pg date value to a 'YYYY-MM-DD' string. node-postgres
// hands DATE columns back as JS Date objects by default; serialised they become
// ISO strings. We compare date-only (no time/timezone), so reduce to the day.
// Throws on anything that isn't a recognisable date — callers pass real dates.
export function toISODate(value) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new Error('Invalid date.');
    return value.toISOString().slice(0, 10);
  }
  const s = String(value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error(`Not a YYYY-MM-DD date: ${value}`);
  return s;
}

// Phase of one period relative to `today` (all date-only). Mirrors the SQL
// period_phase column exactly so the frontend and server never disagree.
// 'upcoming' = starts after today; 'past' = ended before today; else 'current'
// (start <= today <= end, inclusive — the running period that covers today).
export function classifyPeriod({ start_date, end_date, today } = {}) {
  const t = toISODate(today);
  if (toISODate(start_date) > t) return 'upcoming';
  if (toISODate(end_date) < t) return 'past';
  return 'current';
}

// The start date for a NEW stacked period. If the member still has coverage
// (currentEndDate is a real date >= today), the new period abuts it (starts ON
// that end date); otherwise it starts today. Mirrors the SQL anchor
// GREATEST(MAX(end_date) WHERE end_date >= today, today). Pure date-only math.
export function nextStartDate({ currentEndDate, today } = {}) {
  const t = toISODate(today);
  if (currentEndDate == null || currentEndDate === '') return t;
  const end = toISODate(currentEndDate);
  return end >= t ? end : t;
}

// Defence-in-depth guard used by the pause route alongside validatePauseStart:
// you can only pause the period that is actually running today.
export function validatePauseCoverage({ start_date, end_date, today } = {}) {
  const phase = classifyPeriod({ start_date, end_date, today });
  if (phase === 'upcoming') return { ok: false, error: 'This plan has not started yet.' };
  if (phase === 'past') return { ok: false, error: 'This plan has already ended.' };
  return { ok: true };
}

// --- package ⇄ member gender mapping --------------------------------------
// A member is offered their OWN gender's plans plus unisex ('All') plans — the
// same rule the GET /packages?gender= catalogue uses. This is the create-time
// guard so a gendered plan can't be sold to the wrong gender via the API even
// if the UI dropdown is bypassed.
//   Male   member → 'Male'   or 'All' plans
//   Female member → 'Female' or 'All' plans
//   Other  member → 'Other'  or 'All' plans
// A member with no recorded gender (null/'') is unconstrained — we can't map
// what we don't know — and unisex ('All') plans are always allowed.
export function isPackageAllowedForGender(memberGender, packageGender) {
  const pkg = String(packageGender ?? 'All');
  if (pkg === 'All') return true;
  const mem = memberGender == null ? '' : String(memberGender);
  if (mem === '') return true; // no gender on file → no restriction
  return pkg === mem;
}

// A "custom plan": create a membership (invoice) and an optional first payment.
export function validateCustomPlan({
  member_id,
  package_id,
  amount,
  registration_fee,
  discount,
  paid_amount,
  pay_mode,
} = {}) {
  if (!Number.isInteger(Number(member_id)) || Number(member_id) <= 0) {
    return { ok: false, error: 'A member is required.' };
  }
  if (!Number.isInteger(Number(package_id)) || Number(package_id) <= 0) {
    return { ok: false, error: 'A plan is required.' };
  }
  for (const [label, val] of [
    ['Amount', amount],
    ['Registration fee', registration_fee],
    ['Discount', discount],
    ['Paid amount', paid_amount],
  ]) {
    if (val != null && val !== '' && !isNonNegativeNumber(val)) {
      return { ok: false, error: `${label} must be 0 or more.` };
    }
  }
  if (pay_mode != null && pay_mode !== '' && !PAY_MODES.includes(pay_mode)) {
    return { ok: false, error: 'Invalid pay mode.' };
  }
  // When an explicit amount is given we can bound the discount right here.
  // (When amount is blank it defaults to the plan price server-side — the
  // route re-checks with validateDiscount once the price is resolved.)
  if (amount != null && amount !== '') {
    const dv = validateDiscount({ amount, registration_fee, discount });
    if (!dv.ok) return dv;
  }
  return { ok: true };
}
