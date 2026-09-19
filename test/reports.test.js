import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shapePaymentsSummary, paymentsDetailFilter, shapePaymentsDetailRow, shapePaymentsReceiptRow } from '../lib/reports.js';

test('shapePaymentsSummary: coerces pg numeric-strings into real numbers', () => {
  // pg returns SUM()/COUNT() as strings for numeric/bigint columns.
  const out = shapePaymentsSummary({
    pending_amount: '9000.00',
    pending_invoices: '3',
    paid_receipts: '84',
    paid_amount: '210500.00',
    overall_receipts: '120',
    overall_amount: '515000.00',
  });
  assert.deepEqual(out, {
    pending_amount: 9000, pending_invoices: 3,
    paid_receipts: 84, paid_amount: 210500,
    overall_receipts: 120, overall_amount: 515000,
  });
});

test('shapePaymentsSummary: already-numeric input passes through unchanged', () => {
  const inp = { pending_amount: 1500.5, pending_invoices: 2, paid_receipts: 10, paid_amount: 45000.75, overall_receipts: 40, overall_amount: 160000.25 };
  assert.deepEqual(shapePaymentsSummary(inp), inp);
});

test('shapePaymentsSummary: empty gym / missing row → all zeros', () => {
  const zeros = { pending_amount: 0, pending_invoices: 0, paid_receipts: 0, paid_amount: 0, overall_receipts: 0, overall_amount: 0 };
  assert.deepEqual(shapePaymentsSummary(undefined), zeros);
  assert.deepEqual(shapePaymentsSummary(null), zeros);
  assert.deepEqual(shapePaymentsSummary({}), zeros);
});

test('shapePaymentsSummary: null/invalid field values fall back to 0', () => {
  const out = shapePaymentsSummary({ pending_amount: null, pending_invoices: 'abc', paid_receipts: undefined, paid_amount: NaN, overall_receipts: null, overall_amount: 'junk' });
  assert.deepEqual(out, { pending_amount: 0, pending_invoices: 0, paid_receipts: 0, paid_amount: 0, overall_receipts: 0, overall_amount: 0 });
});

test('paymentsDetailFilter: pending = started invoices still owing (no upcoming)', () => {
  const pending = paymentsDetailFilter('pending');
  assert.match(pending, /balance > 0/);
  // Upcoming (not-yet-started) plans are NOT pending until they begin…
  assert.match(pending, /period_phase <> 'upcoming'/);
  // …but started-and-lapsed invoices still count, so no status scoping.
  assert.doesNotMatch(pending, /membership_status/);
  // 'paid' and 'overall' are handled as their own receipts queries in the
  // route, not via this filter whitelist.
  assert.equal(paymentsDetailFilter('paid'), null);
  assert.equal(paymentsDetailFilter('overall'), null);
});

test('paymentsDetailFilter: unknown / unsafe kinds return null (→ 400, no query)', () => {
  assert.equal(paymentsDetailFilter('bogus'), null);
  assert.equal(paymentsDetailFilter(''), null);
  assert.equal(paymentsDetailFilter(undefined), null);
  // A SQL-injection attempt is just an unknown key — never interpolated.
  assert.equal(paymentsDetailFilter("paid'; DROP TABLE member;--"), null);
  // Prototype keys must not leak through as "known".
  assert.equal(paymentsDetailFilter('toString'), null);
  assert.equal(paymentsDetailFilter('constructor'), null);
});

test('shapePaymentsReceiptRow: coerces the amount, passes text/dates through', () => {
  const out = shapePaymentsReceiptRow({
    payment_id: 12, re_no: 61, paid_on: '2026-07-10', paid_amount: '8000.00',
    pay_mode: 'UPI', member_id: 1, full_name: 'Bruno', mobile_no1: '9876543210',
    package_name: 'Personal Training', details: 'Received pending payment — Bruno',
  });
  assert.deepEqual(out, {
    payment_id: 12, re_no: 61, paid_on: '2026-07-10', paid_amount: 8000,
    pay_mode: 'UPI', member_id: 1, full_name: 'Bruno', mobile_no1: '9876543210',
    package_name: 'Personal Training', details: 'Received pending payment — Bruno',
  });
});

test('shapePaymentsReceiptRow: missing row / fields → safe defaults', () => {
  const out = shapePaymentsReceiptRow(undefined);
  assert.equal(out.paid_amount, 0);
  assert.equal(out.full_name, undefined);
});

test('shapePaymentsDetailRow: coerces money to numbers, passes text/dates through', () => {
  const out = shapePaymentsDetailRow({
    membership_id: 7, member_id: 3, full_name: 'Bruno', mobile_no1: '9876543210',
    package_name: '3 Months', end_date: '2026-08-14',
    total_amount: '9000.00', paid_amount: '9000.00', balance: '0',
  });
  assert.deepEqual(out, {
    membership_id: 7, member_id: 3, full_name: 'Bruno', mobile_no1: '9876543210',
    package_name: '3 Months', end_date: '2026-08-14',
    total_amount: 9000, paid_amount: 9000, balance: 0,
  });
});

test('shapePaymentsDetailRow: missing row / fields → safe defaults', () => {
  const out = shapePaymentsDetailRow(undefined);
  assert.equal(out.total_amount, 0);
  assert.equal(out.paid_amount, 0);
  assert.equal(out.balance, 0);
  assert.equal(out.full_name, undefined);
});
