// Bulk member import via Excel: the template the staff downloads and the
// mapping that turns an uploaded sheet back into create-member records.
// Pure helpers live here (unit-testable without a DB); the route wires them
// to exceljs streams and the importer.

/*
 * One entry per template column, in sheet order. `header` is what staff see;
 * `key` is the canonical field the parser maps to. Headers are matched by
 * normalizeHeader(), so reordered/re-typed headers (case, spaces, the *) still
 * resolve — but a renamed column simply won't map, so the parser reports any
 * required column it can't find.
 */
export const TEMPLATE_COLUMNS = [
  { header: 'Full Name *', key: 'full_name', width: 24 },
  { header: 'Mobile No 1 *', key: 'mobile_no1', width: 15 },
  { header: 'Mobile No 2', key: 'mobile_no2', width: 15 },
  { header: 'Email', key: 'email', width: 24 },
  { header: 'Gender', key: 'gender', width: 10 },
  { header: 'Date of Birth', key: 'date_of_birth', width: 14 },
  { header: 'Address', key: 'address', width: 30 },
  { header: 'Occupation', key: 'occupation', width: 16 },
  { header: 'Blood Group', key: 'blood_group', width: 12 },
  { header: 'Height (cm)', key: 'height_cm', width: 11 },
  { header: 'Weight (kg)', key: 'weight_kg', width: 11 },
  { header: 'ID Proof No', key: 'id_proof_no', width: 16 },
  { header: 'Emergency Contact Name', key: 'ec_name', width: 22 },
  { header: 'Emergency Contact Relationship', key: 'ec_relationship', width: 16 },
  { header: 'Emergency Contact Phone', key: 'ec_phone', width: 15 },
  { header: 'Emergency Contact Address', key: 'ec_address', width: 26 },
  { header: 'Guardian Name', key: 'guardian_name', width: 20 },
  { header: 'Guardian Relationship', key: 'guardian_relationship', width: 16 },
  { header: 'Guardian Mobile', key: 'guardian_mobile', width: 15 },
  { header: 'Membership No (blank = auto)', key: 'membership_no', width: 18 },
  { header: 'Batch', key: 'batch', width: 12 },
  { header: 'Trainer', key: 'trainer', width: 16 },
  { header: 'Date of Joining', key: 'date_of_joining', width: 14 },
  { header: 'ID Verified (Yes/No)', key: 'id_verified', width: 12 },
  { header: 'Medical Reviewed (Yes/No)', key: 'medical_reviewed', width: 14 },
  { header: 'Staff Name', key: 'staff_name', width: 16 },
  { header: 'Package (name or ID)', key: 'package', width: 20 },
  { header: 'Membership Start Date', key: 'start_date', width: 14 },
  { header: 'Amount Paid (blank = full price)', key: 'amount_paid', width: 16 },
];

// The only compulsory columns — the same two the Add Member form validates.
// Their headers carry the * and are tinted red in the template.
export const REQUIRED_KEYS = ['full_name', 'mobile_no1'];

const DATE_KEYS = new Set(['date_of_birth', 'date_of_joining', 'start_date']);
const BOOL_KEYS = new Set(['id_verified', 'medical_reviewed']);
const NUMBER_KEYS = new Set(['height_cm', 'weight_kg', 'amount_paid']);

// "Full Name *" / "full_name" / "FULL NAME" all collapse to "fullname".
export function normalizeHeader(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

const HEADER_TO_KEY = new Map(TEMPLATE_COLUMNS.map((c) => [normalizeHeader(c.header), c.key]));
// Staff may keep older sheets around — also accept the raw snake_case keys and
// a few likely respellings as headers.
for (const c of TEMPLATE_COLUMNS) HEADER_TO_KEY.set(normalizeHeader(c.key), c.key);
HEADER_TO_KEY.set(normalizeHeader('Phone 1'), 'mobile_no1');
HEADER_TO_KEY.set(normalizeHeader('Phone 2'), 'mobile_no2');
HEADER_TO_KEY.set(normalizeHeader('DOB'), 'date_of_birth');
HEADER_TO_KEY.set(normalizeHeader('Plan'), 'package');
HEADER_TO_KEY.set(normalizeHeader('Package'), 'package');
HEADER_TO_KEY.set(normalizeHeader('Start Date'), 'start_date');

// What a given header cell maps to (null if unknown) — exported so tests can
// prove every template header resolves to its own column key.
export const headerToKey = (header) => HEADER_TO_KEY.get(normalizeHeader(cellToString(header))) || null;

/*
 * exceljs cell values arrive in many shapes: strings, numbers, Dates, and
 * objects for hyperlinks ({ text, hyperlink }), rich text ({ richText: [...] })
 * and formulas ({ formula, result }). Flatten all of them to a trimmed string;
 * '' means "blank".
 */
export function cellToString(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return excelDateToIso(value);
  if (typeof value === 'object') {
    if ('result' in value) return cellToString(value.result);
    // Hyperlink cells: text is usually a string but can itself be a richText
    // object (or a number/Date from a formula hyperlink) — recurse either way.
    if ('text' in value) return cellToString(value.text);
    if (Array.isArray(value.richText)) return value.richText.map((r) => r.text).join('').trim();
    if ('error' in value) return '';
    return '';
  }
  return String(value).trim();
}

// xlsx date cells come back as JS Dates pinned to UTC — format with UTC getters
// so the calendar date staff typed never shifts across timezones.
function excelDateToIso(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/*
 * Accepts a real Excel date cell (Date), an Excel serial number, or the typed
 * strings YYYY-MM-DD and DD/MM/YYYY (also with "-" or "."; day-first, as dates
 * are written here). Returns 'YYYY-MM-DD', null for blank, or throws with a
 * message naming what it saw.
 */
export function cellToDateStr(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return excelDateToIso(value);
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Excel serial: days since 1899-12-30; the fraction is the time of day, so
    // floor it (rounding would shift noon+ datetimes to the next day). Bound to
    // 1920-01-01..2100-12-31: every plausible DOB/joining date is inside, while
    // a typed year (1990..2100 → serials that decode to 1905) or a stray small
    // number errors instead of silently importing as a 1900s date.
    const serial = Math.floor(value);
    if (serial < 7306 || serial > 73415) {
      throw new Error(`"${value}" is not a date — use YYYY-MM-DD or DD/MM/YYYY, or an Excel date cell.`);
    }
    return excelDateToIso(new Date(Date.UTC(1899, 11, 30) + serial * 86400000));
  }
  const s = cellToString(value);
  if (!s) return null;
  let y, m, d;
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (match) [, y, m, d] = match;
  else {
    match = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s);
    if (match) [, d, m, y] = match;
  }
  if (!match) throw new Error(`"${s}" is not a date — use YYYY-MM-DD or DD/MM/YYYY, or an Excel date cell.`);
  y = Number(y); m = Number(m); d = Number(d);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    throw new Error(`"${s}" is not a real calendar date.`);
  }
  return excelDateToIso(dt);
}

export function cellToBool(value) {
  const s = cellToString(value).toLowerCase();
  if (!s) return false;
  if (['yes', 'y', 'true', '1'].includes(s)) return true;
  if (['no', 'n', 'false', '0'].includes(s)) return false;
  throw new Error(`"${cellToString(value)}" is not Yes/No.`);
}

// Every numeric template column (height, weight, amount paid) is a quantity —
// a negative is always a typo, and a negative Amount Paid would skip the
// receipt while the legacy column stores it, silently mis-billing the member.
export function cellToNumber(value) {
  const s = cellToString(value).replace(/[₹,\s]/g, '');
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) throw new Error(`"${cellToString(value)}" is not a number.`);
  if (n < 0) throw new Error(`"${cellToString(value)}" cannot be negative.`);
  return n;
}

// member.gender has a case-sensitive DB CHECK — normalize the common ways
// staff type it (M/F, lowercase, legacy registers) and fail anything else
// with a labeled row error instead of an opaque DB constraint violation.
const GENDER_MAP = { m: 'Male', male: 'Male', f: 'Female', female: 'Female', o: 'Other', other: 'Other' };
export function cellToGender(value) {
  const s = cellToString(value);
  if (!s) return '';
  const g = GENDER_MAP[s.toLowerCase()];
  if (!g) throw new Error(`"${s}" is not Male/Female/Other.`);
  return g;
}

// Package cell: a numeric package_id or a package name (case-insensitive).
// Returns the package row or throws.
export function resolvePackage(value, packages) {
  const s = cellToString(value);
  if (!s) return null;
  if (/^\d+$/.test(s)) {
    const byId = packages.find((p) => Number(p.package_id) === Number(s));
    if (byId) return byId;
    throw new Error(`Unknown package ID ${s} — see the Packages sheet in the template.`);
  }
  const byName = packages.find((p) => String(p.name).trim().toLowerCase() === s.toLowerCase());
  if (byName) return byName;
  throw new Error(`Unknown package "${s}" — see the Packages sheet in the template.`);
}

/*
 * Map parsed sheet rows to create-member records (the shape POST /api/import
 * already takes). headerCells is row 1 as raw cell values; dataRows is
 * [{ rowNumber, cells }] with cells indexed like exceljs (1-based). A row that
 * fails validation is reported in `errors` with its Excel row number and is NOT
 * imported at all — half-imported rows would duplicate members on re-upload.
 */
export function rowsToRecords(headerCells, dataRows, packages) {
  const keyByCol = new Map();
  headerCells.forEach((h, idx) => {
    const key = HEADER_TO_KEY.get(normalizeHeader(cellToString(h)));
    if (key && !keyByCol.has(key)) keyByCol.set(key, idx);
  });

  const missing = REQUIRED_KEYS.filter((k) => !keyByCol.has(k));
  if (missing.length) {
    const labels = TEMPLATE_COLUMNS.filter((c) => missing.includes(c.key)).map((c) => `"${c.header}"`);
    const err = new Error(`The sheet is missing the ${labels.join(' and ')} column${labels.length > 1 ? 's' : ''}. Download a fresh template and keep its header row.`);
    err.expected = true; // safe to show the uploader verbatim
    throw err;
  }

  const records = [];
  const errors = [];

  for (const { rowNumber, cells } of dataRows) {
    const raw = {};
    for (const [key, idx] of keyByCol) raw[key] = cells[idx];
    if (Object.values(raw).every((v) => cellToString(v) === '')) continue; // blank row

    try {
      const fields = {};
      for (const [key, value] of Object.entries(raw)) {
        const label = TEMPLATE_COLUMNS.find((c) => c.key === key)?.header || key;
        try {
          if (DATE_KEYS.has(key)) fields[key] = cellToDateStr(value);
          else if (BOOL_KEYS.has(key)) fields[key] = cellToBool(value);
          else if (NUMBER_KEYS.has(key)) fields[key] = cellToNumber(value);
          else if (key === 'gender') fields[key] = cellToGender(value);
          else fields[key] = cellToString(value);
        } catch (e) {
          throw new Error(`${label}: ${e.message}`);
        }
      }

      if (!fields.full_name) throw new Error('Full Name is required.');
      if (!fields.mobile_no1) throw new Error('Mobile No 1 is required.');
      // A contact without a name can't be stored — fail the row rather than
      // silently dropping a typed phone number (same idea as the orphan
      // Package check below).
      if (!fields.ec_name && (fields.ec_relationship || fields.ec_phone || fields.ec_address)) {
        throw new Error('Emergency-contact cells are filled but Emergency Contact Name is blank.');
      }
      if (!fields.guardian_name && (fields.guardian_relationship || fields.guardian_mobile)) {
        throw new Error('Guardian cells are filled but Guardian Name is blank.');
      }

      const record = {
        _row: rowNumber,
        member: {
          full_name: fields.full_name,
          date_of_birth: fields.date_of_birth,
          gender: fields.gender || null,
          address: fields.address || null,
          mobile_no1: fields.mobile_no1,
          mobile_no2: fields.mobile_no2 || null,
          email: fields.email || null,
          occupation: fields.occupation || null,
          blood_group: fields.blood_group || null,
          height_cm: fields.height_cm,
          weight_kg: fields.weight_kg,
          id_proof_no: fields.id_proof_no || null,
        },
        emergencyContacts: fields.ec_name
          ? [{ name: fields.ec_name, relationship: fields.ec_relationship || null, phone: fields.ec_phone || null, address: fields.ec_address || null }]
          : [],
        guardians: fields.guardian_name
          ? [{ name: fields.guardian_name, relationship: fields.guardian_relationship || null, mobile_number: fields.guardian_mobile || null }]
          : [],
        // Always present so every imported member gets an office_use row and an
        // auto membership number, same as the Add Member form.
        office: {
          membership_no: fields.membership_no || null,
          batch: fields.batch || null,
          trainer: fields.trainer || null,
          date_of_joining: fields.date_of_joining,
          id_verified: fields.id_verified || false,
          medical_reviewed: fields.medical_reviewed || false,
          staff_name: fields.staff_name || null,
        },
      };

      const pkg = resolvePackage(raw.package, packages);
      if (pkg) {
        record.membership = {
          package_id: Number(pkg.package_id),
          // When the sheet leaves Membership Start Date blank, begin the period
          // on the member's Date of Joining (this is a migration of existing
          // members, so their plan started when they joined) — falling back to
          // today only when neither date is given. An explicit Membership Start
          // Date always wins.
          start_date: fields.start_date || fields.date_of_joining,
          amount_paid: fields.amount_paid,
        };
      } else if (fields.start_date || fields.amount_paid != null) {
        throw new Error('A Membership Start Date / Amount Paid was given but the Package cell is blank.');
      }

      records.push(record);
    } catch (e) {
      errors.push({ row: rowNumber, reason: e.message });
    }
  }

  return { records, errors };
}

/*
 * The downloadable template: a "Members" sheet with just the header row (so
 * sample data can never be imported by accident), an "Example" sheet showing
 * one filled row, and a "Packages" sheet listing the live plans so staff know
 * the valid names/IDs.
 */
export async function buildTemplateWorkbook(packages) {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();

  const ws = wb.addWorksheet('Members', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = TEMPLATE_COLUMNS.map(({ header, key, width }) => ({ header, key, width }));
  ws.getRow(1).font = { bold: true };
  for (const key of REQUIRED_KEYS) {
    ws.getRow(1).getCell(ws.getColumn(key).number).font = { bold: true, color: { argb: 'FFC23A2B' } };
  }

  // Dropdowns for the constrained cells (rows 2-501).
  const colLetter = (key) => ws.getColumn(key).letter;
  for (let row = 2; row <= 501; row++) {
    ws.getCell(`${colLetter('gender')}${row}`).dataValidation = {
      type: 'list', allowBlank: true, formulae: ['"Male,Female,Other"'],
    };
    for (const key of ['id_verified', 'medical_reviewed']) {
      ws.getCell(`${colLetter(key)}${row}`).dataValidation = {
        type: 'list', allowBlank: true, formulae: ['"Yes,No"'],
      };
    }
    if (packages.length) {
      ws.getCell(`${colLetter('package')}${row}`).dataValidation = {
        type: 'list', allowBlank: true, formulae: [`Packages!$B$2:$B$${packages.length + 1}`],
      };
    }
  }

  const example = wb.addWorksheet('Example');
  example.columns = TEMPLATE_COLUMNS.map(({ header, key, width }) => ({ header, key, width }));
  example.getRow(1).font = { bold: true };
  for (const key of REQUIRED_KEYS) {
    example.getRow(1).getCell(example.getColumn(key).number).font = { bold: true, color: { argb: 'FFC23A2B' } };
  }
  example.addRow({
    full_name: 'Rahul Sharma', mobile_no1: '9876543210', mobile_no2: '', email: 'rahul@example.com',
    gender: 'Male', date_of_birth: '1995-08-15', address: '12 MG Road, Sirsi', occupation: 'Engineer',
    blood_group: 'B+', height_cm: 175, weight_kg: 72, id_proof_no: 'AADH-1234',
    ec_name: 'Priya Sharma', ec_relationship: 'Spouse', ec_phone: '9876500000', ec_address: '12 MG Road, Sirsi',
    guardian_name: '', guardian_relationship: '', guardian_mobile: '',
    membership_no: '', batch: 'Morning', trainer: 'Suresh', date_of_joining: '2026-07-01',
    id_verified: 'Yes', medical_reviewed: 'No', staff_name: 'Admin',
    package: packages[0]?.name || '1 Month', start_date: '2026-07-01', amount_paid: '',
  });
  example.addRow({});
  example.addRow({ full_name: 'This sheet is just an example — enter real members on the "Members" sheet.' });

  const pkgSheet = wb.addWorksheet('Packages');
  pkgSheet.columns = [
    { header: 'ID', key: 'package_id', width: 6 },
    { header: 'Name', key: 'name', width: 22 },
    { header: 'Price (₹)', key: 'price', width: 12 },
    { header: 'Duration', key: 'duration', width: 12 },
    { header: 'For', key: 'gender', width: 10 },
  ];
  pkgSheet.getRow(1).font = { bold: true };
  for (const p of packages) {
    pkgSheet.addRow({
      ...p,
      duration: p.duration_days
        ? `${p.duration_days} day${Number(p.duration_days) === 1 ? '' : 's'}`
        : `${p.duration_months} month${Number(p.duration_months) === 1 ? '' : 's'}`,
    });
  }

  return wb;
}
