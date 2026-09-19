import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatMembershipNo, expiryWindowDays } from '../lib/members.js';

test('formatMembershipNo: derives a stable, unique number from member_id', () => {
  // Mirrors the seeded format (member 1 → MM-1001).
  assert.equal(formatMembershipNo(1), 'MM-1001');
  assert.equal(formatMembershipNo(2), 'MM-1002');
  assert.equal(formatMembershipNo(42), 'MM-1042');
  assert.equal(formatMembershipNo(9000), 'MM-10000');
  // Stable: the same id always maps to the same number.
  assert.equal(formatMembershipNo(7), formatMembershipNo(7));
  // Unique: different ids never collide.
  assert.notEqual(formatMembershipNo(7), formatMembershipNo(8));
  // pg hands integers back fine either as number or numeric string.
  assert.equal(formatMembershipNo('15'), 'MM-1015');
});

test('formatMembershipNo: returns null for ids that cannot exist', () => {
  assert.equal(formatMembershipNo(0), null);
  assert.equal(formatMembershipNo(-1), null);
  assert.equal(formatMembershipNo(1.5), null);
  assert.equal(formatMembershipNo(null), null);
  assert.equal(formatMembershipNo(undefined), null);
  assert.equal(formatMembershipNo('abc'), null);
});

test('expiryWindowDays: defaults to 7, accepts valid windows, clamps the upper bound', () => {
  assert.equal(expiryWindowDays(7), 7);
  assert.equal(expiryWindowDays('30'), 30);
  assert.equal(expiryWindowDays(1), 1);
  assert.equal(expiryWindowDays(366), 366);
  assert.equal(expiryWindowDays(100000), 366); // clamped
  assert.equal(expiryWindowDays(14.9), 14);    // truncated
});

test('expiryWindowDays: missing / invalid / non-positive input falls back to 7', () => {
  assert.equal(expiryWindowDays(undefined), 7);
  assert.equal(expiryWindowDays(null), 7);
  assert.equal(expiryWindowDays(''), 7);
  assert.equal(expiryWindowDays('abc'), 7);
  assert.equal(expiryWindowDays(0), 7);
  assert.equal(expiryWindowDays(-5), 7);
});
