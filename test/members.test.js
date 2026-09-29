import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatMembershipNo, expiryWindowDays, MEMBER_STATUSES, memberListFilter, memberExportNames } from '../lib/members.js';

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

test('memberListFilter: no search and no status means every member', () => {
  assert.deepEqual(memberListFilter({}), { where: '', params: [] });
  assert.deepEqual(memberListFilter(), { where: '', params: [] });
  assert.deepEqual(memberListFilter({ search: '', status: '' }), { where: '', params: [] });
});

test('memberListFilter: each roster status filters to exactly that status', () => {
  for (const status of MEMBER_STATUSES) {
    assert.deepEqual(memberListFilter({ status }), { where: 'WHERE status = $1', params: [status] });
  }
  // The dashboard's filter options — including the two-word "No Plan".
  assert.deepEqual(memberListFilter({ status: 'No Plan' }).params, ['No Plan']);
  assert.deepEqual(memberListFilter({ status: 'Inactive' }).params, ['Inactive']);
});

test('memberListFilter: name search is case-insensitive and combines with status', () => {
  assert.deepEqual(memberListFilter({ search: 'BrU' }), {
    where: 'WHERE lower(full_name) LIKE $1',
    params: ['%bru%'],
  });
  assert.deepEqual(memberListFilter({ search: 'bru', status: 'Active' }), {
    where: 'WHERE lower(full_name) LIKE $1 AND status = $2',
    params: ['%bru%', 'Active'],
  });
});

test('memberListFilter: an unknown status is ignored, never put into SQL', () => {
  assert.deepEqual(memberListFilter({ status: 'Expired' }), { where: '', params: [] });
  assert.deepEqual(memberListFilter({ status: "Active' OR 1=1 --" }), { where: '', params: [] });
  assert.deepEqual(memberListFilter({ status: 'active' }), { where: '', params: [] });
  assert.deepEqual(memberListFilter({ status: ['Active', 'Inactive'] }), { where: '', params: [] });
});

test('memberListFilter: a repeated ?search= does not throw', () => {
  assert.deepEqual(memberListFilter({ search: ['Bru', 'Lee'] }).params, ['%bru,lee%']);
});

test('memberExportNames: names the sheet and file after the chosen status', () => {
  const date = '2026-09-29';
  assert.deepEqual(memberExportNames('Active', date), { sheet: 'Active Members', filename: 'members-active-2026-09-29.xlsx' });
  assert.deepEqual(memberExportNames('Inactive', date), { sheet: 'Inactive Members', filename: 'members-inactive-2026-09-29.xlsx' });
  assert.deepEqual(memberExportNames('No Plan', date), { sheet: 'No Plan Members', filename: 'members-no-plan-2026-09-29.xlsx' });
  assert.equal(memberExportNames('Upcoming', date).filename, 'members-upcoming-2026-09-29.xlsx');
  assert.equal(memberExportNames('Paused', date).filename, 'members-paused-2026-09-29.xlsx');
});

test('memberExportNames: blank or unknown status falls back to "all"', () => {
  const date = '2026-09-29';
  const all = { sheet: 'All Members', filename: 'members-all-2026-09-29.xlsx' };
  assert.deepEqual(memberExportNames('', date), all);
  assert.deepEqual(memberExportNames(undefined, date), all);
  assert.deepEqual(memberExportNames('x"; evil=1', date), all);
  assert.deepEqual(memberExportNames(['Active'], date), all);
});

test('memberExportNames: sheet names stay within Excel\'s 31-character limit', () => {
  for (const status of MEMBER_STATUSES) {
    assert.ok(memberExportNames(status, '2026-09-29').sheet.length <= 31);
  }
});
