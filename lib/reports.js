// Pure report helpers — no DB, no I/O — so they can be unit-tested with
// `node --test`.

// Shape the raw payments-summary DB row into the JSON the Payments page reads.
// Coerces pg's numeric-as-string values into real numbers so the frontend can
// format them without re-parsing, and defaults every field so a missing row
// (empty gym) yields zeros rather than nulls.
//
//  - pending_amount  : total rupees still OWED across invoices with a balance
//                      whose plan has STARTED (active or lapsed). Upcoming
//                      (queued, not-yet-started) plans are excluded — a member
//                      isn't dunned for a plan that hasn't begun. This is the
//                      "chip" total and agrees with the pending drill-down table.
//  - pending_invoices: how many invoices make up that pending amount.
//  - paid_receipts   : receipts taken this CALENDAR MONTH (resets on the 1st).
//  - paid_amount     : rupees received across those receipts — same month
//                      bounds as the dashboard's revenue_this_month tile.
//  - overall_receipts: every receipt ever taken (all-time, never resets).
//  - overall_amount  : all-time rupees received; the monthly figure is always
//                      a subset of this.
export function shapePaymentsSummary(row) {
  const r = row || {};
  return {
    pending_amount: Number(r.pending_amount) || 0,
    pending_invoices: Number(r.pending_invoices) || 0,
    paid_receipts: Number(r.paid_receipts) || 0,
    paid_amount: Number(r.paid_amount) || 0,
    overall_receipts: Number(r.overall_receipts) || 0,
    overall_amount: Number(r.overall_amount) || 0,
  };
}

// The pending-chip drill-down filter over membership_billing. Whitelisted here
// (never string-built from user input) so the ?kind= query param can only ever
// pick a safe filter. The paid drill-down is no longer a filter over this view
// — it lists the current month's payment receipts and has its own query in the
// route — so 'pending' is the only entry.
//   - pending: invoices still carrying a balance whose plan has STARTED —
//              upcoming/queued plans are excluded until they begin (kept in
//              lock-step with the pending_* figures in the summary).
const DETAIL_FILTERS = {
  pending: `b.balance > 0 AND b.period_phase <> 'upcoming'`,
};

// Resolve a ?kind= value to its whitelisted SQL filter, or null if unknown
// (the route turns null into a clean 400 — no query is ever run).
export function paymentsDetailFilter(kind) {
  return Object.hasOwn(DETAIL_FILTERS, kind) ? DETAIL_FILTERS[kind] : null;
}

// Shape one paid-chip drill-down row (a payment receipt from this month).
// Coerces pg numeric-strings to numbers; to_char dates and text pass through.
export function shapePaymentsReceiptRow(row) {
  const r = row || {};
  return {
    payment_id: r.payment_id,
    re_no: r.re_no,
    paid_on: r.paid_on,
    paid_amount: Number(r.paid_amount) || 0,
    pay_mode: r.pay_mode,
    details: r.details, // free-text note/tag, e.g. "Received pending payment — <member>"
    member_id: r.member_id,
    full_name: r.full_name,
    mobile_no1: r.mobile_no1,
    package_name: r.package_name,
  };
}

// Shape one pending-chip drill-down row (a single membership/invoice).
// Coerces pg numeric-strings to numbers; leaves already-formatted date strings
// (to_char) and text fields untouched.
export function shapePaymentsDetailRow(row) {
  const r = row || {};
  return {
    membership_id: r.membership_id,
    member_id: r.member_id,
    full_name: r.full_name,
    mobile_no1: r.mobile_no1,
    package_name: r.package_name,
    end_date: r.end_date,
    total_amount: Number(r.total_amount) || 0,
    paid_amount: Number(r.paid_amount) || 0,
    balance: Number(r.balance) || 0,
  };
}
