import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TEMPLATE_COLUMNS,
  normalizeHeader,
  headerToKey,
  cellToString,
  cellToDateStr,
  cellToBool,
  cellToNumber,
  cellToGender,
  resolvePackage,
  rowsToRecords,
  buildTemplateWorkbook,
} from '../lib/importExcel.js';

const PACKAGES = [
  { package_id: 1, name: '1 Month', price: '3500.00', duration_months: 1, duration_days: null, gender: 'All' },
  { package_id: 2, name: '3 Months', price: '9000.00', duration_months: 3, duration_days: null, gender: 'All' },
  { package_id: 5, name: 'Ladies Special', price: '3000.00', duration_months: 1, duration_days: null, gender: 'Female' },
  { package_id: 9, name: '45 Day Shred', price: '4500.00', duration_months: null, duration_days: 45, gender: 'All' },
];

// Build header/data rows the way the route does (1-based cell arrays).
const headerRow = () => {
  const cells = [];
  TEMPLATE_COLUMNS.forEach((c, i) => { cells[i + 1] = c.header; });
  return cells;
};
const dataRow = (rowNumber, byKey) => {
  const cells = [];
  TEMPLATE_COLUMNS.forEach((c, i) => { cells[i + 1] = byKey[c.key] ?? null; });
  return { rowNumber, cells };
};

test('cellToString: flattens exceljs cell value shapes', () => {
  assert.equal(cellToString('  hi  '), 'hi');
  assert.equal(cellToString(9876543210), '9876543210'); // phone typed as a number
  assert.equal(cellToString(null), '');
  assert.equal(cellToString(undefined), '');
  assert.equal(cellToString({ text: 'a@b.com', hyperlink: 'mailto:a@b.com' }), 'a@b.com');
  assert.equal(cellToString({ richText: [{ text: 'Rahul ' }, { text: 'Sharma' }] }), 'Rahul Sharma');
  // Hyperlink whose display text is itself rich text (auto-linked emails).
  assert.equal(cellToString({ text: { richText: [{ text: 'r@x.com' }] }, hyperlink: 'mailto:r@x.com' }), 'r@x.com');
  assert.equal(cellToString({ formula: 'A1&B1', result: 'joined' }), 'joined');
  assert.equal(cellToString(new Date(Date.UTC(1995, 7, 15))), '1995-08-15');
});

test('cellToDateStr: Excel dates, serials, and the two accepted string formats', () => {
  assert.equal(cellToDateStr(new Date(Date.UTC(1995, 7, 15))), '1995-08-15');
  assert.equal(cellToDateStr('1995-08-15'), '1995-08-15');
  assert.equal(cellToDateStr('15/08/1995'), '1995-08-15');
  assert.equal(cellToDateStr('15-08-1995'), '1995-08-15');
  assert.equal(cellToDateStr('5/8/1995'), '1995-08-05'); // day-first
  assert.equal(cellToDateStr(45870), '2025-08-01');       // Excel serial
  assert.equal(cellToDateStr(45870.5), '2025-08-01');     // fraction = time of day, floored
  assert.equal(cellToDateStr(''), null);
  assert.equal(cellToDateStr(null), null);
  assert.throws(() => cellToDateStr('yesterday'), /not a date/);
  assert.throws(() => cellToDateStr('31/02/2026'), /not a real calendar date/);
  // A typed year (2026) or stray 0 is NOT a plausible Excel serial — reject
  // instead of silently importing a 1900s date.
  assert.throws(() => cellToDateStr(2026), /not a date/);
  assert.throws(() => cellToDateStr(0), /not a date/);
  assert.throws(() => cellToDateStr(80000), /not a date/); // past 2100
});

test('cellToGender: normalizes M/F/case variants, rejects the rest', () => {
  assert.equal(cellToGender('Male'), 'Male');
  assert.equal(cellToGender('female'), 'Female');
  assert.equal(cellToGender('M'), 'Male');
  assert.equal(cellToGender('f'), 'Female');
  assert.equal(cellToGender('OTHER'), 'Other');
  assert.equal(cellToGender(''), '');
  assert.throws(() => cellToGender('boy'), /not Male\/Female\/Other/);
});

test('cellToBool / cellToNumber: forgiving input, loud failure', () => {
  assert.equal(cellToBool('Yes'), true);
  assert.equal(cellToBool('no'), false);
  assert.equal(cellToBool(''), false);
  assert.equal(cellToBool(1), true);
  assert.throws(() => cellToBool('maybe'), /not Yes\/No/);

  assert.equal(cellToNumber('3500'), 3500);
  assert.equal(cellToNumber('₹3,500'), 3500); // currency formatting survives
  assert.equal(cellToNumber(''), null);
  assert.equal(cellToNumber(172.5), 172.5);
  assert.throws(() => cellToNumber('tall'), /not a number/);
  assert.throws(() => cellToNumber('-500'), /cannot be negative/); // stray minus = mis-billing
});

test('resolvePackage: by ID, by case-insensitive name, and clear misses', () => {
  assert.equal(resolvePackage('2', PACKAGES).name, '3 Months');
  assert.equal(resolvePackage('ladies special', PACKAGES).package_id, 5);
  assert.equal(resolvePackage('', PACKAGES), null);
  assert.throws(() => resolvePackage('99', PACKAGES), /Unknown package ID 99/);
  assert.throws(() => resolvePackage('Gold', PACKAGES), /Unknown package "Gold"/);
});

test('rowsToRecords: a full row maps to the create-member record shape', () => {
  const { records, errors } = rowsToRecords(
    headerRow(),
    [dataRow(2, {
      full_name: 'Rahul Sharma', mobile_no1: 9876543210, email: { text: 'r@x.com', hyperlink: 'mailto:r@x.com' },
      gender: 'Male', date_of_birth: '15/08/1995', height_cm: '175', weight_kg: 72,
      ec_name: 'Priya', ec_phone: '9876500000',
      guardian_name: 'Om Sharma', guardian_mobile: 9000000001,
      batch: 'Morning', id_verified: 'Yes', medical_reviewed: 'No',
      package: '3 months', start_date: '2026-07-01', amount_paid: '₹4,500',
    })],
    PACKAGES,
  );
  assert.equal(errors.length, 0);
  assert.equal(records.length, 1);
  const r = records[0];
  assert.equal(r._row, 2);
  assert.equal(r.member.full_name, 'Rahul Sharma');
  assert.equal(r.member.mobile_no1, '9876543210');
  assert.equal(r.member.email, 'r@x.com');
  assert.equal(r.member.date_of_birth, '1995-08-15');
  assert.equal(r.member.height_cm, 175);
  assert.deepEqual(r.emergencyContacts, [{ name: 'Priya', relationship: null, phone: '9876500000', address: null }]);
  assert.deepEqual(r.guardians, [{ name: 'Om Sharma', relationship: null, mobile_number: '9000000001' }]);
  assert.equal(r.office.batch, 'Morning');
  assert.equal(r.office.id_verified, true);
  assert.equal(r.office.medical_reviewed, false);
  assert.deepEqual(r.membership, { package_id: 2, start_date: '2026-07-01', amount_paid: 4500 });
});

test('rowsToRecords: blank Membership Start Date falls back to Date of Joining', () => {
  const { records } = rowsToRecords(
    headerRow(),
    [
      // No Membership Start Date, but a Date of Joining is given → period starts then.
      dataRow(2, { full_name: 'Migrated Member', mobile_no1: '9', date_of_joining: '09/06/2026', package: '3 months' }),
      // Explicit Membership Start Date always wins over Date of Joining.
      dataRow(3, { full_name: 'Explicit Start', mobile_no1: '9', date_of_joining: '01/01/2026', start_date: '2026-07-01', package: '3 months' }),
      // Neither date → left blank so the DB defaults it to today (CURRENT_DATE).
      dataRow(4, { full_name: 'No Dates', mobile_no1: '9', package: '3 months' }),
    ],
    PACKAGES,
  );
  assert.equal(records[0].membership.start_date, '2026-06-09'); // from Date of Joining
  assert.equal(records[0].office.date_of_joining, '2026-06-09'); // still recorded on office too
  assert.equal(records[1].membership.start_date, '2026-07-01'); // explicit wins
  assert.equal(records[2].membership.start_date, null);         // neither → null → DB defaults to today (COALESCE)
});

test('rowsToRecords: blank rows skipped; bad rows reported with their sheet row, never half-mapped', () => {
  const { records, errors } = rowsToRecords(
    headerRow(),
    [
      dataRow(2, {}), // fully blank — ignored
      dataRow(3, { full_name: 'No Phone' }),
      dataRow(4, { full_name: 'Bad Date', mobile_no1: '9', date_of_birth: 'soon' }),
      dataRow(5, { full_name: 'Bad Plan', mobile_no1: '9', package: 'Gold' }),
      dataRow(6, { full_name: 'Orphan Start', mobile_no1: '9', start_date: '2026-07-01' }),
      dataRow(7, { full_name: 'OK', mobile_no1: '9876543210' }),
      dataRow(8, { full_name: 'Orphan EC', mobile_no1: '9', ec_phone: '9876500000' }),
      dataRow(9, { full_name: 'Orphan Guardian', mobile_no1: '9', guardian_mobile: '9876500001' }),
      dataRow(10, { full_name: 'Bad Gender', mobile_no1: '9', gender: 'boy' }),
    ],
    PACKAGES,
  );
  assert.equal(records.length, 1);
  assert.equal(records[0].member.full_name, 'OK');
  assert.equal(records[0].membership, undefined); // no package → no membership key
  assert.deepEqual(errors.map((e) => e.row), [3, 4, 5, 6, 8, 9, 10]);
  assert.match(errors[0].reason, /Mobile No 1 is required/);
  assert.match(errors[1].reason, /Date of Birth/);
  assert.match(errors[2].reason, /Unknown package "Gold"/);
  assert.match(errors[3].reason, /Package cell is blank/);
  assert.match(errors[4].reason, /Emergency Contact Name is blank/);
  assert.match(errors[5].reason, /Guardian Name is blank/);
  assert.match(errors[6].reason, /Gender.*not Male\/Female\/Other/);
});

test('rowsToRecords: headers match case/spacing-insensitively and out of order', () => {
  const cells = [];
  cells[1] = 'MOBILE NO 1';        // required, moved + re-cased
  cells[2] = 'full_name *';        // snake_case alias
  cells[3] = 'DOB';                // alias
  const { records, errors } = rowsToRecords(
    cells,
    [{ rowNumber: 2, cells: [undefined, '9876543210', 'Asha', '01/01/2000'] }],
    PACKAGES,
  );
  assert.equal(errors.length, 0);
  assert.equal(records[0].member.full_name, 'Asha');
  assert.equal(records[0].member.mobile_no1, '9876543210');
  assert.equal(records[0].member.date_of_birth, '2000-01-01');
});

test('rowsToRecords: a sheet without the required columns fails loudly (expected error)', () => {
  assert.throws(
    () => rowsToRecords(['', 'Nickname', 'Shoe Size'], [], PACKAGES),
    (e) => e.expected === true && /missing the "Full Name \*" and "Mobile No 1 \*"/.test(e.message),
  );
});

test('template round-trip: the workbook GET /template serves parses back through rowsToRecords', async () => {
  const wb = await buildTemplateWorkbook(PACKAGES);
  const ws = wb.getWorksheet('Members');
  assert.ok(ws, 'template has a Members sheet');

  // Read the header row exactly the way the /excel route does.
  const headerCells = [];
  ws.getRow(1).eachCell({ includeEmpty: true }, (cell, col) => { headerCells[col] = cell.value; });
  assert.equal(headerCells.filter(Boolean).length, TEMPLATE_COLUMNS.length);

  // Every template header must resolve to ITS OWN column key, and no two
  // headers may normalize to the same string (keyByCol keeps the first match,
  // so a collision would silently drop the second column's data).
  const normalized = new Set();
  TEMPLATE_COLUMNS.forEach((c, i) => {
    assert.equal(headerToKey(headerCells[i + 1]), c.key, `header "${headerCells[i + 1]}" must map to ${c.key}`);
    const norm = normalizeHeader(c.header);
    assert.ok(!normalized.has(norm), `duplicate normalized header: ${norm}`);
    normalized.add(norm);
  });

  // A row written under those headers maps cleanly — template and parser agree.
  const { records, errors } = rowsToRecords(
    headerCells,
    [dataRow(2, { full_name: 'Round Trip', mobile_no1: '9111111111', package: '1 Month' })],
    PACKAGES,
  );
  assert.equal(errors.length, 0);
  assert.equal(records[0].member.full_name, 'Round Trip');
  assert.equal(records[0].membership.package_id, 1);

  // Packages sheet lists the live plans for staff, with the duration labeled
  // in whichever unit the plan carries.
  const pkgSheet = wb.getWorksheet('Packages');
  assert.equal(pkgSheet.rowCount, PACKAGES.length + 1);
  const durations = [];
  pkgSheet.eachRow((row, n) => { if (n > 1) durations.push(row.getCell(4).value); });
  assert.deepEqual(durations, ['1 month', '3 months', '1 month', '45 days']);
  assert.ok(wb.getWorksheet('Example'), 'template has an Example sheet');
});
