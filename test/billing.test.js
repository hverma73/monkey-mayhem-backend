import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  round2,
  computeTotal,
  sumPayments,
  computeBalance,
  validatePayment,
  validatePaymentBound,
  expectedBalanceConflict,
  validateCustomPlan,
  validateDiscount,
  pauseBudgetForMonths,
  pauseBudgetForPlan,
  validatePauseStart,
  validateResume,
  cappedPauseDays,
  toISODate,
  classifyPeriod,
  nextStartDate,
  validatePauseCoverage,
  isPackageAllowedForGender,
  PAY_MODES,
} from '../lib/billing.js';

test('round2 rounds to 2 decimals and tolerates junk', () => {
  assert.equal(round2(2500.567), 2500.57); // rounds up
  assert.equal(round2(2500.564), 2500.56); // rounds down
  assert.equal(round2('2500.5'), 2500.5);
  assert.equal(round2(null), 0);
  assert.equal(round2(undefined), 0);
});

test('computeTotal = amount + registrationFee - discount', () => {
  assert.equal(computeTotal({ amount: 3500, registrationFee: 0, discount: 0 }), 3500);
  assert.equal(computeTotal({ amount: 9000, registrationFee: 500, discount: 1000 }), 8500);
  assert.equal(computeTotal({ amount: '9000', registrationFee: '500.50', discount: '0.50' }), 9500);
  assert.equal(computeTotal({}), 0);
});

test('sumPayments adds paid_amount across rows (strings from pg ok)', () => {
  assert.equal(sumPayments([{ paid_amount: '1000' }, { paid_amount: 2500 }]), 3500);
  assert.equal(sumPayments([]), 0);
  assert.equal(sumPayments(), 0);
  assert.equal(sumPayments([{ paid_amount: null }, { paid_amount: '500' }]), 500);
});

test('computeBalance = total - paid', () => {
  assert.equal(computeBalance({ amount: 3500, paidAmount: 0 }), 3500);
  assert.equal(computeBalance({ amount: 3500, paidAmount: 3500 }), 0);
  assert.equal(
    computeBalance({ amount: 9000, registrationFee: 500, discount: 1000, paidAmount: 5000 }),
    3500,
  );
});

test('validatePayment accepts valid input', () => {
  assert.deepEqual(validatePayment({ paid_amount: 1000, pay_mode: 'Cash', paid_on: '2026-06-10' }), {
    ok: true,
  });
  assert.deepEqual(validatePayment({ paid_amount: 0 }), { ok: true }); // 0 allowed
  assert.deepEqual(validatePayment({ paid_amount: '500', pay_mode: '' }), { ok: true });
});

test('validatePayment rejects bad input', () => {
  assert.equal(validatePayment({ paid_amount: -5 }).ok, false);
  assert.equal(validatePayment({ paid_amount: 'abc' }).ok, false);
  assert.equal(validatePayment({ paid_amount: 100, pay_mode: 'Bitcoin' }).ok, false);
  assert.equal(validatePayment({ paid_amount: 100, paid_on: 'not-a-date' }).ok, false);
});

test('PAY_MODES are all accepted by validatePayment', () => {
  for (const mode of PAY_MODES) {
    assert.deepEqual(validatePayment({ paid_amount: 1, pay_mode: mode }), { ok: true });
  }
});

test('validateCustomPlan requires member + plan, non-negative money', () => {
  assert.deepEqual(
    validateCustomPlan({ member_id: 1, package_id: 2, amount: 3500, paid_amount: 3500 }),
    { ok: true },
  );
  assert.equal(validateCustomPlan({ package_id: 2 }).ok, false); // no member
  assert.equal(validateCustomPlan({ member_id: 1 }).ok, false); // no plan
  assert.equal(validateCustomPlan({ member_id: 1, package_id: 2, discount: -1 }).ok, false);
  assert.equal(validateCustomPlan({ member_id: 1, package_id: 2, pay_mode: 'Gold' }).ok, false);
  assert.equal(validateCustomPlan({ member_id: 'x', package_id: 2 }).ok, false);
});

test('pauseBudgetForMonths: standard tiers + fallback + garbage', () => {
  assert.equal(pauseBudgetForMonths(1), 7);
  assert.equal(pauseBudgetForMonths(3), 15);
  assert.equal(pauseBudgetForMonths(6), 30);
  assert.equal(pauseBudgetForMonths(12), 60);
  assert.equal(pauseBudgetForMonths(2), 10); // fallback max(7, round(2*5))
  assert.equal(pauseBudgetForMonths(4), 20);
  assert.equal(pauseBudgetForMonths(0), 0);
  assert.equal(pauseBudgetForMonths('x'), 0);
  assert.equal(pauseBudgetForMonths(-3), 0);
});

test('pauseBudgetForPlan: day-based plans scale at ~5/30; months delegate unchanged', () => {
  // Day plans (custom packages since migration 008).
  assert.equal(pauseBudgetForPlan({ duration_days: 30 }), 7);   // month-equivalent keeps the floor
  assert.equal(pauseBudgetForPlan({ duration_days: 90 }), 15);  // = 3-month tier
  assert.equal(pauseBudgetForPlan({ duration_days: 45 }), 8);   // round(45*5/30), floor applies (>=30d)
  assert.equal(pauseBudgetForPlan({ duration_days: 10 }), 2);   // short trial: no 7-day floor
  assert.equal(pauseBudgetForPlan({ duration_days: 1 }), 0);    // round(1*5/30) = 0
  // Month plans behave exactly as before.
  assert.equal(pauseBudgetForPlan({ duration_months: 3 }), 15);
  assert.equal(pauseBudgetForPlan({ duration_months: 1 }), 7);
  // Garbage / missing.
  assert.equal(pauseBudgetForPlan({}), 0);
  assert.equal(pauseBudgetForPlan({ duration_days: -5 }), 0);
  assert.equal(pauseBudgetForPlan({ duration_days: null, duration_months: null }), 0);
});

test('validatePauseStart: only an active membership with budget can pause', () => {
  assert.deepEqual(validatePauseStart({ membershipStatus: 'Active', remaining: 10 }), { ok: true });
  assert.equal(validatePauseStart({ membershipStatus: 'Paused', remaining: 10 }).ok, false);
  assert.equal(validatePauseStart({ membershipStatus: 'Inactive', remaining: 10 }).ok, false);
  assert.equal(validatePauseStart({ membershipStatus: 'No Plan', remaining: 10 }).ok, false);
  assert.equal(validatePauseStart({ membershipStatus: 'Active', remaining: 0 }).ok, false);
});

test('validatePauseStart: optional plannedDays must be a whole number within budget', () => {
  assert.deepEqual(validatePauseStart({ membershipStatus: 'Active', remaining: 15, plannedDays: 10 }), { ok: true });
  assert.deepEqual(validatePauseStart({ membershipStatus: 'Active', remaining: 15, plannedDays: '' }), { ok: true }); // blank = open-ended
  assert.equal(validatePauseStart({ membershipStatus: 'Active', remaining: 15, plannedDays: 20 }).ok, false); // over budget
  assert.equal(validatePauseStart({ membershipStatus: 'Active', remaining: 15, plannedDays: 0 }).ok, false);
  assert.equal(validatePauseStart({ membershipStatus: 'Active', remaining: 15, plannedDays: 2.5 }).ok, false);
});

test('validateResume: only a paused membership can resume', () => {
  assert.deepEqual(validateResume({ membershipStatus: 'Paused' }), { ok: true });
  assert.equal(validateResume({ membershipStatus: 'Active' }).ok, false);
  assert.equal(validateResume({ membershipStatus: 'Inactive' }).ok, false);
});

test('cappedPauseDays: elapsed clamped to [0, remaining]', () => {
  assert.equal(cappedPauseDays(5, 10), 5);
  assert.equal(cappedPauseDays(12, 10), 10); // capped at budget
  assert.equal(cappedPauseDays(0, 10), 0);
  assert.equal(cappedPauseDays(-3, 10), 0);
  assert.equal(cappedPauseDays(5, 0), 0);
  assert.equal(cappedPauseDays(5.9, 10), 5); // floors
});

test('toISODate normalises strings, Date objects, and pg ISO timestamps to YYYY-MM-DD', () => {
  assert.equal(toISODate('2026-08-14'), '2026-08-14');
  assert.equal(toISODate('2026-08-14T00:00:00.000Z'), '2026-08-14'); // pg DATE serialised
  assert.equal(toISODate(new Date('2026-08-14T00:00:00.000Z')), '2026-08-14');
  assert.throws(() => toISODate('not-a-date'));
  assert.throws(() => toISODate('14/08/2026'));
});

test('classifyPeriod: upcoming / current / past with inclusive boundaries', () => {
  const today = '2026-06-25';
  assert.equal(classifyPeriod({ start_date: '2026-06-01', end_date: '2026-07-01', today }), 'current');
  assert.equal(classifyPeriod({ start_date: '2026-06-26', end_date: '2026-07-26', today }), 'upcoming');
  assert.equal(classifyPeriod({ start_date: '2026-01-01', end_date: '2026-06-24', today }), 'past');
  // Boundaries are inclusive: start == today and end == today both count as current.
  assert.equal(classifyPeriod({ start_date: '2026-06-25', end_date: '2026-09-25', today }), 'current');
  assert.equal(classifyPeriod({ start_date: '2026-03-25', end_date: '2026-06-25', today }), 'current');
  // pg may hand back Date objects / ISO strings — still classified correctly.
  assert.equal(classifyPeriod({ start_date: '2026-06-01T00:00:00.000Z', end_date: '2026-07-01T00:00:00.000Z', today }), 'current');
});

test('nextStartDate: stacks on current coverage end, else today (abutting, no +1)', () => {
  const today = '2026-06-25';
  assert.equal(nextStartDate({ currentEndDate: '2026-09-04', today }), '2026-09-04'); // future end -> abut
  assert.equal(nextStartDate({ currentEndDate: '2026-06-25', today }), '2026-06-25'); // ends today -> today
  assert.equal(nextStartDate({ currentEndDate: '2026-01-10', today }), '2026-06-25'); // already past -> today
  assert.equal(nextStartDate({ currentEndDate: null, today }), '2026-06-25');         // no coverage -> today
  assert.equal(nextStartDate({ currentEndDate: '', today }), '2026-06-25');
});

test('validatePauseCoverage: only a currently-running period can be paused', () => {
  const today = '2026-06-25';
  assert.deepEqual(validatePauseCoverage({ start_date: '2026-06-01', end_date: '2026-07-01', today }), { ok: true });
  assert.equal(validatePauseCoverage({ start_date: '2026-07-01', end_date: '2026-08-01', today }).ok, false); // upcoming
  assert.equal(validatePauseCoverage({ start_date: '2026-01-01', end_date: '2026-06-01', today }).ok, false); // past
});

test('validatePauseStart rejects the new Upcoming status (pins the taxonomy)', () => {
  assert.equal(validatePauseStart({ membershipStatus: 'Upcoming', remaining: 10 }).ok, false);
});

test('isPackageAllowedForGender: members get their own gender plus unisex', () => {
  // Male → Male + All; everything else for a male is rejected.
  assert.equal(isPackageAllowedForGender('Male', 'Male'), true);
  assert.equal(isPackageAllowedForGender('Male', 'All'), true);
  assert.equal(isPackageAllowedForGender('Male', 'Female'), false);
  assert.equal(isPackageAllowedForGender('Male', 'Other'), false);
  // Female → Female + All.
  assert.equal(isPackageAllowedForGender('Female', 'Female'), true);
  assert.equal(isPackageAllowedForGender('Female', 'All'), true);
  assert.equal(isPackageAllowedForGender('Female', 'Male'), false);
  // Other → Other + All.
  assert.equal(isPackageAllowedForGender('Other', 'Other'), true);
  assert.equal(isPackageAllowedForGender('Other', 'All'), true);
  assert.equal(isPackageAllowedForGender('Other', 'Female'), false);
});

test('isPackageAllowedForGender: unisex always allowed; unknown member gender unconstrained', () => {
  // 'All' (unisex) plans go to anyone, including a member with no gender.
  assert.equal(isPackageAllowedForGender(null, 'All'), true);
  assert.equal(isPackageAllowedForGender('', 'All'), true);
  // No gender on file → can't map, so no restriction (matches GET /packages).
  assert.equal(isPackageAllowedForGender(null, 'Male'), true);
  assert.equal(isPackageAllowedForGender('', 'Female'), true);
  assert.equal(isPackageAllowedForGender(undefined, 'Other'), true);
  // A null/undefined package gender defaults to unisex.
  assert.equal(isPackageAllowedForGender('Male', null), true);
  assert.equal(isPackageAllowedForGender('Female', undefined), true);
});

test('validateDiscount: discount may not exceed amount + registration fee', () => {
  assert.equal(validateDiscount({ amount: 3500, registration_fee: 0, discount: 3500 }).ok, true);   // 100% off is legal
  assert.equal(validateDiscount({ amount: 3500, registration_fee: 500, discount: 4000 }).ok, true); // exactly gross
  assert.equal(validateDiscount({ amount: 3500, registration_fee: 0, discount: 5000 }).ok, false);  // negative total
  assert.equal(validateDiscount({ amount: 0, registration_fee: 0, discount: 1 }).ok, false);
  // pg numeric-strings and blanks coerce sanely.
  assert.equal(validateDiscount({ amount: '9000', registration_fee: '500', discount: '9500' }).ok, true);
  assert.equal(validateDiscount({ amount: '', registration_fee: '', discount: '' }).ok, true);
  assert.equal(validateDiscount({}).ok, true);
});

test('validateCustomPlan: rejects a discount above the explicit amount + fee', () => {
  const base = { member_id: 1, package_id: 2 };
  assert.equal(validateCustomPlan({ ...base, amount: 3500, discount: 5000 }).ok, false);
  assert.equal(validateCustomPlan({ ...base, amount: 3500, registration_fee: 2000, discount: 5000 }).ok, true);
  // Blank amount defers to the plan price — the route re-checks after resolving.
  assert.equal(validateCustomPlan({ ...base, discount: 5000 }).ok, true);
  assert.equal(validateCustomPlan({ ...base, amount: '', discount: 5000 }).ok, true);
});

test('validatePaymentBound: blocks receipts over 10x the invoice total', () => {
  assert.equal(validatePaymentBound({ paid_amount: 35000, total_amount: 3500 }).ok, true);   // exactly 10x — allowed
  assert.equal(validatePaymentBound({ paid_amount: 35001, total_amount: 3500 }).ok, false);  // over 10x — typo guard
  assert.equal(validatePaymentBound({ paid_amount: 1000000, total_amount: '3500.00' }).ok, false); // pg string total
  // Small overpayments (credits) stay legal.
  assert.equal(validatePaymentBound({ paid_amount: 4000, total_amount: 3500 }).ok, true);
});

test('validatePaymentBound: skips the check when the total is missing or zero', () => {
  assert.equal(validatePaymentBound({ paid_amount: 1000000, total_amount: 0 }).ok, true);
  assert.equal(validatePaymentBound({ paid_amount: 1000000, total_amount: null }).ok, true);
  assert.equal(validatePaymentBound({ paid_amount: 1000000 }).ok, true);
  assert.equal(validatePaymentBound({}).ok, true);
});

test('expectedBalanceConflict: no expectation → never a conflict (ordinary add-payment path)', () => {
  assert.equal(expectedBalanceConflict(null, 3500), false);
  assert.equal(expectedBalanceConflict('', 3500), false);
  assert.equal(expectedBalanceConflict(undefined, 3500), false);
});

test('expectedBalanceConflict: matching expectation is fine, tolerates 2dp noise', () => {
  assert.equal(expectedBalanceConflict(3500, 3500), false);
  assert.equal(expectedBalanceConflict('1500.00', 1500), false);
  assert.equal(expectedBalanceConflict(1500.004, 1500), false); // within epsilon
});

test('expectedBalanceConflict: a changed current balance is a conflict', () => {
  assert.equal(expectedBalanceConflict(3500, 1500), true);  // someone paid 2000 first
  assert.equal(expectedBalanceConflict(3500, 0), true);     // already fully settled
  assert.equal(expectedBalanceConflict(1500, 1500.5), true); // beyond epsilon
});

test('expectedBalanceConflict: non-numeric current is treated as no-conflict (fail open, other guards catch it)', () => {
  assert.equal(expectedBalanceConflict(3500, null), false);
  assert.equal(expectedBalanceConflict(3500, 'abc'), false);
});
