import express from 'express';
import { pool, query } from '../db.js';
import { formatMembershipNo } from '../lib/members.js';
import { isPackageAllowedForGender, validatePaymentBound } from '../lib/billing.js';
import { rowsToRecords, buildTemplateWorkbook } from '../lib/importExcel.js';

const router = express.Router();

// A validation failure we want to show the importer verbatim (vs. an internal
// DB error, whose message could leak constraint/column details to the client).
function importError(message) {
  const err = new Error(message);
  err.expected = true;
  return err;
}

/*
 * Insert an array of member records (same shape as the create endpoint).
 * Each record is inserted in its own transaction so one bad row doesn't sink
 * the batch. `_row` (source spreadsheet row) overrides the reported row number.
 * Returns { received, inserted, failed, errors }.
 */
async function importRecords(records, executive) {
  let inserted = 0;
  const errors = [];
  // Mobiles / typed card numbers already imported in THIS batch (recorded on
  // success only, so a failed row doesn't block a later duplicate of itself).
  const batchMobiles = new Map();
  const batchMembershipNos = new Map();

  for (let i = 0; i < records.length; i++) {
    const rec = records[i] || {};
    const rowNo = rec._row || i + 1;
    const m = rec.member || rec; // allow flat records too
    if (!m.full_name || !m.mobile_no1) {
      errors.push({ row: rowNo, reason: 'Missing full_name or mobile_no1.' });
      continue;
    }
    const typedNo = rec.office?.membership_no || null;

    // pool.connect() lives INSIDE the try: a DB blip mid-batch must fail that
    // row (and the following ones) instead of throwing out of importRecords
    // after earlier rows already committed.
    let client;
    try {
      client = await pool.connect();

      // Duplicate guards. The designed flow is "fix the bad rows, re-upload
      // the file" — without these, every previously-successful row would
      // import again (same person twice, two receipts, two card numbers).
      const dupRow = batchMobiles.get(String(m.mobile_no1));
      if (dupRow) throw importError(`Same Mobile No 1 as row ${dupRow} of this file.`);
      const existing = (await client.query(
        `SELECT m.full_name, o.membership_no FROM member m
         LEFT JOIN office_use o USING (member_id)
         WHERE m.mobile_no1 = $1 LIMIT 1`,
        [m.mobile_no1]
      )).rows[0];
      if (existing) {
        throw importError(
          `A member with mobile ${m.mobile_no1} already exists (${existing.full_name}${existing.membership_no ? ', ' + existing.membership_no : ''}) — remove this row if it was already imported, or add them via the Add Member form.`
        );
      }
      if (typedNo) {
        const dupNoRow = batchMembershipNos.get(typedNo);
        if (dupNoRow) throw importError(`Membership No ${typedNo} is also used on row ${dupNoRow} of this file.`);
        const taken = (await client.query(
          `SELECT m.full_name FROM office_use o JOIN member m USING (member_id)
           WHERE o.membership_no = $1 LIMIT 1`,
          [typedNo]
        )).rows[0];
        if (taken) throw importError(`Membership No ${typedNo} is already assigned to ${taken.full_name}.`);
      }

      await client.query('BEGIN');

      const { rows } = await client.query(
        `INSERT INTO member (full_name, date_of_birth, gender, address, mobile_no1,
            mobile_no2, email, occupation, blood_group, height_cm, weight_kg,
            id_proof_no, photo_url)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         RETURNING member_id`,
        [m.full_name, m.date_of_birth || null, m.gender || null, m.address || null,
         m.mobile_no1, m.mobile_no2 || null, m.email || null, m.occupation || null,
         m.blood_group || null, m.height_cm || null, m.weight_kg || null,
         m.id_proof_no || null, m.photo_url || null]
      );
      const memberId = rows[0].member_id;

      for (const ec of rec.emergencyContacts || []) {
        if (!ec?.name) continue;
        await client.query(
          `INSERT INTO emergency_contact (member_id, name, relationship, phone, address)
           VALUES ($1,$2,$3,$4,$5)`,
          [memberId, ec.name, ec.relationship || null, ec.phone || null, ec.address || null]
        );
      }
      for (const g of rec.guardians || []) {
        if (!g?.name) continue;
        await client.query(
          `INSERT INTO guardian (member_id, name, relationship, mobile_number)
           VALUES ($1,$2,$3,$4)`,
          [memberId, g.name, g.relationship || null, g.mobile_number || null]
        );
      }
      if (rec.office) {
        const o = rec.office;
        await client.query(
          `INSERT INTO office_use (member_id, membership_no, batch, trainer,
              date_of_joining, id_verified, medical_reviewed, staff_name, staff_signature)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          // Keep an explicit legacy number if provided, else auto-derive one.
          [memberId, o.membership_no || formatMembershipNo(memberId), o.batch || null, o.trainer || null,
           o.date_of_joining || null, !!o.id_verified, !!o.medical_reviewed,
           o.staff_name || null, o.staff_signature || null]
        );
      }
      if (rec.membership?.package_id) {
        const ms = rec.membership;
        // Same gender ⇄ package guard as every other membership write path —
        // import must not be a back door for selling a gendered plan to the
        // wrong gender. Also surfaces an unknown package_id as a row error
        // instead of silently skipping the membership insert.
        const pkg = (await client.query(
          'SELECT gender AS package_gender, name AS package_name FROM package WHERE package_id = $1',
          [ms.package_id]
        )).rows[0];
        if (!pkg) throw importError(`Unknown package_id ${ms.package_id}.`);
        if (!isPackageAllowedForGender(m.gender, pkg.package_gender)) {
          throw importError(`The "${pkg.package_name}" plan is for ${pkg.package_gender} members and can't be assigned to a ${m.gender} member.`);
        }
        // Blank start_date falls back to CURRENT_DATE in SQL (not the Node UTC
        // date, which is yesterday before 05:30 IST) — same as the form path.
        const msResult = await client.query(
          `INSERT INTO membership (member_id, package_id, start_date, end_date, amount_paid, amount)
           SELECT $1, p.package_id, COALESCE($2::date, CURRENT_DATE),
                  (COALESCE($2::date, CURRENT_DATE) + COALESCE(p.duration_days * INTERVAL '1 day',
                                                               (p.duration_months || ' months')::interval))::date,
                  COALESCE($3, p.price), p.price
           FROM package p WHERE p.package_id = $4
           RETURNING id, amount_paid, amount`,
          [memberId, ms.start_date || null, ms.amount_paid ?? null, ms.package_id]
        );
        // Record the paid amount as a payment receipt (executive = importer).
        const row = msResult.rows[0];
        if (row && Number(row.amount_paid) > 0) {
          // 10× typo guard — a phone number pasted into the Amount Paid column
          // must fail this row, not corrupt every earnings report.
          const bound = validatePaymentBound({ paid_amount: row.amount_paid, total_amount: row.amount });
          if (!bound.ok) throw importError(bound.error);
          await client.query(
            `INSERT INTO payment (membership_id, member_id, paid_amount, pay_mode, executive)
             VALUES ($1, $2, $3, 'Cash', $4)`,
            [row.id, memberId, row.amount_paid, executive]
          );
        }
      }

      await client.query('COMMIT');
      inserted++;
      batchMobiles.set(String(m.mobile_no1), rowNo);
      if (typedNo) batchMembershipNos.set(typedNo, rowNo);
    } catch (err) {
      // ROLLBACK can itself throw on a dead connection — swallow that so the
      // original row error is what gets reported, not an escaped rejection.
      if (client) await client.query('ROLLBACK').catch(() => {});
      // Our own validation messages are safe to show; raw DB errors are logged
      // server-side only (they can leak constraint/column internals).
      if (!err.expected) console.error(`import row ${rowNo}:`, err);
      errors.push({ row: rowNo, reason: err.expected ? err.message : 'Could not import this record.' });
    } finally {
      if (client) client.release();
    }
  }

  return { received: records.length, inserted, failed: errors.length, errors };
}

/*
 * POST /api/import — JSON body: an array of member records, e.g.
 * [
 *   {
 *     "member": { "full_name": "...", "mobile_no1": "...", ... },
 *     "emergencyContacts": [ { "name": "...", "relationship": "...", "phone": "..." } ],
 *     "guardians": [ { "name": "...", "mobile_number": "..." } ],
 *     "office": { "membership_no": "...", "batch": "...", "trainer": "..." },
 *     "membership": { "package_id": 2, "start_date": "2026-01-01" }
 *   }
 * ]
 * Kept for scripted imports (e.g. registration-form conversions); the Import
 * Members page now uploads the Excel template to POST /api/import/excel.
 */
router.post('/', async (req, res) => {
  const records = Array.isArray(req.body) ? req.body : req.body?.members;
  if (!Array.isArray(records)) {
    return res.status(400).json({ error: 'Upload a JSON array of members.' });
  }
  try {
    res.json(await importRecords(records, req.user?.name || null));
  } catch (err) {
    // Express 4 doesn't catch async throws — an escaped rejection here would
    // kill the whole process.
    console.error('json import:', err);
    res.status(500).json({ error: 'Could not import.' });
  }
});

// Active plans only — retired packages must not appear in the template's
// Packages sheet or be sellable by name/ID through an import (the Add Member
// form's catalogue applies the same filter).
const packageRows = () =>
  query('SELECT package_id, name, price, duration_months, duration_days, gender FROM package WHERE is_active ORDER BY package_id')
    .then((r) => r.rows);

/*
 * GET /api/import/template — the blank .xlsx staff fill in, with an Example
 * sheet and the live package list baked into a Packages sheet.
 */
router.get('/template', async (req, res) => {
  try {
    const wb = await buildTemplateWorkbook(await packageRows());
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="member-import-template.xlsx"');
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ error: 'Could not build the import template.' });
  }
});

/*
 * POST /api/import/excel — body: the filled template as raw .xlsx bytes.
 * Rows are validated and mapped in lib/importExcel.js, then imported through
 * the same per-row-transaction path as the JSON import. A row that fails
 * validation is skipped entirely (never half-imported) and reported with its
 * spreadsheet row number.
 */
router.post(
  '/excel',
  express.raw({
    type: ['application/octet-stream', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    limit: '10mb',
  }),
  async (req, res) => {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({ error: 'Upload the filled .xlsx template.' });
    }

    let headerCells, dataRows;
    try {
      const ExcelJS = (await import('exceljs')).default;
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(req.body);
      const ws = wb.getWorksheet('Members') || wb.worksheets[0];
      if (!ws) return res.status(400).json({ error: 'The file has no worksheet. Start from the downloaded template.' });

      headerCells = [];
      ws.getRow(1).eachCell({ includeEmpty: true }, (cell, col) => { headerCells[col] = cell.value; });
      dataRows = [];
      ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
        if (rowNumber === 1) return;
        const cells = [];
        row.eachCell({ includeEmpty: true }, (cell, col) => { cells[col] = cell.value; });
        dataRows.push({ rowNumber, cells });
      });
    } catch (err) {
      console.error('excel import: unreadable workbook:', err.message);
      return res.status(400).json({ error: 'Could not read that file as an .xlsx workbook. Start from the downloaded template.' });
    }

    try {
      // Throws only for a broken header row (per-row problems come back in errors).
      const { records, errors: rowErrors } = rowsToRecords(headerCells, dataRows, await packageRows());
      if (!records.length && !rowErrors.length) {
        return res.status(400).json({ error: 'No member rows found — fill in the "Members" sheet of the template.' });
      }

      const result = await importRecords(records, req.user?.name || null);
      const errors = [...rowErrors, ...result.errors].sort((a, b) => a.row - b.row);
      res.json({
        received: records.length + rowErrors.length,
        inserted: result.inserted,
        failed: errors.length,
        errors,
      });
    } catch (err) {
      if (err.expected) return res.status(400).json({ error: err.message });
      console.error('excel import:', err);
      res.status(500).json({ error: 'Could not import that file.' });
    }
  }
);

export default router;
