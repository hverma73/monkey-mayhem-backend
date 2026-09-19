import express from 'express';
import { query } from '../db.js';
import { business } from '../config/business.js';
import { shapePaymentsSummary, paymentsDetailFilter, shapePaymentsDetailRow, shapePaymentsReceiptRow } from '../lib/reports.js';

const router = express.Router();

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const today = () => new Date().toISOString().slice(0, 10);
// Coerce/clamp a year so it's safe in SQL and in the download filename.
const toYear = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 2000 && n <= 2100 ? n : Number(today().slice(0, 4));
};

// Stream an exceljs workbook as an .xlsx attachment.
async function sendWorkbook(res, wb, filename) {
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  await wb.xlsx.write(res);
  res.end();
}

/* ================================================================== *
 *  0. Payments summary  (the two chips at the top of the Payments page)
 *     - paid: money RECEIVED this CALENDAR MONTH — receipt count + rupee sum
 *         from the payment ledger, reset on the 1st. Bounded both sides with
 *         the same window as /members/stats revenue_this_month, so the chip
 *         and the dashboard tile always agree.
 *     - overall: ALL-TIME money received — every receipt ever taken. Never
 *         resets; the month chip is always a subset of this figure.
 *     - pending: invoices that still owe a balance AND whose plan has started
 *         (active or lapsed). Upcoming/queued plans are excluded until they
 *         begin — a member isn't dunned for a plan that hasn't started.
 *         pending_invoices = how many owe.
 * ================================================================== */
router.get('/payments-summary', async (_req, res) => {
  try {
    const { rows } = await query(`
      SELECT
        -- Started invoices still carrying a balance → the money left to collect
        -- (upcoming plans are not pending until they begin).
        COALESCE(SUM(b.balance) FILTER (WHERE b.balance > 0 AND b.period_phase <> 'upcoming'), 0) AS pending_amount,
        -- How many invoices make up that pending amount.
        COUNT(*) FILTER (WHERE b.balance > 0 AND b.period_phase <> 'upcoming')                    AS pending_invoices,
        -- Receipts taken this calendar month (bounded both sides so a
        -- future-dated receipt can't count now and again when its month comes).
        ( SELECT COUNT(*) FROM payment p
           WHERE p.paid_on >= date_trunc('month', CURRENT_DATE)
             AND p.paid_on <  date_trunc('month', CURRENT_DATE) + interval '1 month' ) AS paid_receipts,
        -- Money received across those receipts.
        ( SELECT COALESCE(SUM(p.paid_amount), 0) FROM payment p
           WHERE p.paid_on >= date_trunc('month', CURRENT_DATE)
             AND p.paid_on <  date_trunc('month', CURRENT_DATE) + interval '1 month' ) AS paid_amount,
        -- All-time earnings: every receipt ever taken.
        ( SELECT COUNT(*) FROM payment p )                                             AS overall_receipts,
        ( SELECT COALESCE(SUM(p.paid_amount), 0) FROM payment p )                      AS overall_amount
      FROM membership_billing b
    `);
    res.json(shapePaymentsSummary(rows[0]));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load the payments summary.' });
  }
});

/* ------------------------------------------------------------------ *
 *  0b. Payments summary drill-down  (clicking a chip)
 *      /api/reports/payments-summary/detail?kind=paid|pending
 *      kind=paid    → this calendar month's payment receipts (who paid, when,
 *                     how much) — the rows behind the Total Payments chip.
 *      kind=overall → every receipt ever taken — behind Overall Earnings.
 *      kind=pending → invoices still carrying a balance — who's remaining.
 * ------------------------------------------------------------------ */
router.get('/payments-summary/detail', async (req, res) => {
  try {
    if (req.query.kind === 'paid' || req.query.kind === 'overall') {
      // 'paid' uses the same month bounds as the summary above so rows always
      // sum to the chip; 'overall' is the identical query with no time bound.
      const monthBound = req.query.kind === 'paid'
        ? `WHERE pm.paid_on >= date_trunc('month', CURRENT_DATE)
             AND pm.paid_on <  date_trunc('month', CURRENT_DATE) + interval '1 month'`
        : '';
      const { rows } = await query(`
        SELECT pm.payment_id, pm.re_no, to_char(pm.paid_on,'YYYY-MM-DD') AS paid_on,
               pm.paid_amount, pm.pay_mode, pm.details,
               b.member_id, b.full_name, b.mobile_no1, b.package_name
        FROM payment pm
        JOIN membership_billing b ON b.membership_id = pm.membership_id
        ${monthBound}
        ORDER BY pm.paid_on DESC, pm.payment_id DESC
      `);
      return res.json(rows.map(shapePaymentsReceiptRow));
    }

    const filter = paymentsDetailFilter(req.query.kind);
    if (!filter) return res.status(400).json({ error: 'Unknown kind — use paid or pending.' });
    const { rows } = await query(pendingRowsSql(filter));
    res.json(rows.map(shapePaymentsDetailRow));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load the payment details.' });
  }
});

// The pending drill-down rows — shared by the JSON detail route above and the
// Excel export below so the file always matches the table on screen.
const pendingRowsSql = (filter) => `
  SELECT b.membership_id, b.member_id, b.full_name, b.mobile_no1,
         b.package_name, to_char(b.end_date,'YYYY-MM-DD') AS end_date,
         b.total_amount, b.paid_amount, b.balance
  FROM membership_billing b
  WHERE ${filter}
  ORDER BY b.full_name, b.end_date DESC
`;

/* ------------------------------------------------------------------ *
 *  0c. Pending payments export — the drill-down table as an .xlsx,
 *      for chasing collections offline.
 * ------------------------------------------------------------------ */
router.get('/pending/export', async (_req, res) => {
  try {
    const { rows } = await query(pendingRowsSql(paymentsDetailFilter('pending')));
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Pending Payments');
    ws.columns = [
      { header: 'Member', key: 'full_name', width: 26 },
      { header: 'Phone', key: 'mobile_no1', width: 16 },
      { header: 'Package', key: 'package_name', width: 18 },
      { header: 'Expires', key: 'end_date', width: 13 },
      { header: 'Total', key: 'total_amount', width: 13 },
      { header: 'Paid', key: 'paid_amount', width: 13 },
      { header: 'Balance Due', key: 'balance', width: 13 },
    ];
    ws.getRow(1).font = { bold: true };
    for (const r of rows) {
      ws.addRow({
        ...r,
        total_amount: Number(r.total_amount),
        paid_amount: Number(r.paid_amount),
        balance: Number(r.balance),
      });
    }
    ['total_amount', 'paid_amount', 'balance'].forEach((k) => { ws.getColumn(k).numFmt = '#,##0.00'; });
    await sendWorkbook(res, wb, `pending-payments-${today()}.xlsx`);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ error: 'Could not export pending payments.' });
  }
});

/* ================================================================== *
 *  1. Invoices  (one row per membership / invoice)
 * ================================================================== */
function invoicesQuery(search) {
  const params = [];
  let where = '';
  if (search) {
    params.push(`%${String(search).toLowerCase()}%`);
    where = `WHERE lower(b.full_name) LIKE $1`;
  }
  const sql = `
    SELECT b.membership_id,
           b.invoice_no                       AS invoice_id,
           to_char(b.created_at,'YYYY-MM-DD') AS invoice_date,
           b.member_id,
           b.full_name                        AS member_name,
           b.mobile_no1                       AS member_contact,
           b.package_name,
           (b.end_date - b.start_date)        AS duration_days,
           to_char(b.start_date,'YYYY-MM-DD') AS start_date,
           to_char(b.end_date,'YYYY-MM-DD')   AS end_date,
           to_char(b.end_date,'YYYY-MM-DD')   AS next_payment_date,
           b.amount                           AS package_fees,
           b.paid_amount                      AS final_paid,
           b.balance                          AS final_balance
    FROM membership_billing b
    ${where}
    ORDER BY b.invoice_no DESC`;
  return { sql, params };
}

router.get('/invoices', async (req, res) => {
  try {
    const { sql, params } = invoicesQuery(req.query.search);
    const { rows } = await query(sql, params);
    // Package_Type is the gym discipline (not stored per-package).
    res.json(rows.map((r) => ({ ...r, package_type: business.discipline })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load invoices.' });
  }
});

router.get('/invoices/export', async (req, res) => {
  try {
    const { sql, params } = invoicesQuery(req.query.search);
    const { rows } = await query(sql, params);
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Invoices');
    ws.columns = [
      { header: 'Invoice_ID', key: 'invoice_id', width: 11 },
      { header: 'Invoice_date', key: 'invoice_date', width: 13 },
      { header: 'Member_ID', key: 'member_id', width: 10 },
      { header: 'Member_Name', key: 'member_name', width: 24 },
      { header: 'Member_Contact', key: 'member_contact', width: 16 },
      { header: 'Package_Type', key: 'package_type', width: 14 },
      { header: 'Package_Name', key: 'package_name', width: 18 },
      { header: 'Duration_Days', key: 'duration_days', width: 13 },
      { header: 'Start_Date', key: 'start_date', width: 13 },
      { header: 'End_Date', key: 'end_date', width: 13 },
      { header: 'NextPaymentDate', key: 'next_payment_date', width: 15 },
      { header: 'Package_Fees', key: 'package_fees', width: 13 },
      { header: 'Final_paid', key: 'final_paid', width: 13 },
      { header: 'Final_Balance', key: 'final_balance', width: 13 },
    ];
    ws.getRow(1).font = { bold: true };
    for (const r of rows) {
      ws.addRow({
        ...r,
        package_type: business.discipline,
        duration_days: Number(r.duration_days),
        package_fees: Number(r.package_fees),
        final_paid: Number(r.final_paid),
        final_balance: Number(r.final_balance),
      });
    }
    ['package_fees', 'final_paid', 'final_balance'].forEach((k) => { ws.getColumn(k).numFmt = '#,##0.00'; });
    await sendWorkbook(res, wb, `invoices-${today()}.xlsx`);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ error: 'Could not export invoices.' });
  }
});

/* ================================================================== *
 *  2. Payment History  (per-member month grid for a calendar year)
 * ================================================================== */
async function paymentHistoryRows(year) {
  // Month integers below are code-generated constants (1..12), never user input.
  const agg = MONTHS.map((_, i) =>
    `SUM(pm.paid_amount) FILTER (WHERE date_part('month', pm.paid_on) = ${i + 1}) AS m${i + 1}`).join(',\n           ');
  const sel = MONTHS.map((_, i) => `COALESCE(c.m${i + 1}, 0) AS m${i + 1}`).join(', ');
  const sql = `
    WITH collected AS (
      SELECT pm.member_id,
             ${agg},
             SUM(pm.paid_amount) AS year_total,
             MAX(pm.re_no)       AS last_re_no,
             COUNT(*)            AS receipt_count
      FROM payment pm
      WHERE date_part('year', pm.paid_on) = $1
      GROUP BY pm.member_id
    )
    SELECT m.member_id, m.full_name,
           ${sel},
           COALESCE(c.year_total, 0)   AS year_total,
           c.last_re_no,
           COALESCE(c.receipt_count,0) AS receipt_count,
           date_part('month', o.end_date)::int AS due_month,
           date_part('year',  o.end_date)::int AS due_year,
           COALESCE(due.total_due, 0)  AS due_balance
    FROM member m
    LEFT JOIN collected c     ON c.member_id = m.member_id
    LEFT JOIN member_overview o ON o.member_id = m.member_id
    -- A member can hold several billable periods, but member_overview.balance is
    -- only the CURRENT one's. Sum EVERY outstanding invoice so "Due" matches the
    -- Pending Payments chip and the Member Report (both per-invoice totals).
    -- (due_month/due_year keep member_overview's period end as the placement.)
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(b.balance) FILTER (WHERE b.balance > 0), 0) AS total_due
      FROM membership_billing b WHERE b.member_id = m.member_id
    ) due ON true
    ORDER BY m.full_name`;
  const { rows } = await query(sql, [year]);
  return rows.map((r) => ({
    member_id: r.member_id,
    full_name: r.full_name,
    months: MONTHS.map((_, i) => Number(r[`m${i + 1}`]) || 0),
    year_total: Number(r.year_total) || 0,
    last_re_no: r.last_re_no,
    receipt_count: Number(r.receipt_count) || 0,
    due_month: r.due_month, // 1..12 or null
    due_year: r.due_year,
    due_balance: Number(r.due_balance) || 0,
  }));
}

router.get('/payment-history', async (req, res) => {
  try {
    const year = toYear(req.query.year);
    const rows = await paymentHistoryRows(year);
    res.json({ year, monthLabels: MONTHS, rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load payment history.' });
  }
});

router.get('/payment-history/export', async (req, res) => {
  try {
    const year = toYear(req.query.year);
    const rows = await paymentHistoryRows(year);
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(`Payment History ${year}`);

    // Two-row header: id cols + 12 collected months + Receipt + a merged
    // "Due on" banner over 12 due-month columns.  Cols: A..C, D..O, P, Q..AB.
    const r1 = ws.getRow(1);
    const r2 = ws.getRow(2);
    r1.getCell(1).value = 'SL NO';
    r1.getCell(2).value = 'MEM ID';
    r1.getCell(3).value = 'Name';
    MONTHS.forEach((mo, i) => { r1.getCell(4 + i).value = mo; });   // D1..O1 collected
    r1.getCell(16).value = 'Receipt';                               // P1
    r1.getCell(17).value = 'Due on';                                // Q1 (banner)
    MONTHS.forEach((mo, i) => { r2.getCell(17 + i).value = mo; });  // Q2..AB2 due months

    ws.mergeCells(1, 1, 2, 1);
    ws.mergeCells(1, 2, 2, 2);
    ws.mergeCells(1, 3, 2, 3);
    for (let c = 4; c <= 15; c++) ws.mergeCells(1, c, 2, c);
    ws.mergeCells(1, 16, 2, 16);
    ws.mergeCells(1, 17, 1, 28);
    [r1, r2].forEach((r) => { r.font = { bold: true }; r.alignment = { horizontal: 'center', vertical: 'middle' }; });

    rows.forEach((row, idx) => {
      const due = Array(12).fill(null);
      if (row.due_year === year && row.due_month && row.due_balance > 0) {
        due[row.due_month - 1] = row.due_balance;
      }
      const cells = [
        idx + 1, row.member_id, row.full_name,
        ...row.months.map((v) => (v > 0 ? v : null)), // blank empty months (matches the register look)
        row.year_total,
        ...due,
      ];
      ws.addRow(cells);
    });

    ws.getColumn(1).width = 7;
    ws.getColumn(2).width = 9;
    ws.getColumn(3).width = 24;
    for (let c = 4; c <= 28; c++) {
      ws.getColumn(c).width = 11;
      ws.getColumn(c).numFmt = '#,##0.00';
    }
    await sendWorkbook(res, wb, `payment-history-${year}-${today()}.xlsx`);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ error: 'Could not export payment history.' });
  }
});

/* ================================================================== *
 *  3. Member Report  (one row per member, incl. No-Plan members)
 * ================================================================== */
function membersQuery(search) {
  const params = [];
  let where = '';
  if (search) {
    params.push(`%${String(search).toLowerCase()}%`);
    where = `WHERE lower(m.full_name) LIKE $1`;
  }
  const sql = `
    SELECT m.member_id,
           to_char(COALESCE(ou.date_of_joining, m.created_at::date),'YYYY-MM-DD') AS registration_date,
           m.full_name           AS name,
           m.mobile_no1          AS contact,
           m.gender,
           m.email,
           o.status              AS member_status,
           to_char(o.end_date,'YYYY-MM-DD') AS end_date,
           COALESCE(bal.total_balance, 0)   AS final_balance
    FROM member m
    LEFT JOIN office_use     ou ON ou.member_id = m.member_id
    LEFT JOIN member_overview o ON o.member_id  = m.member_id
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(b.balance),0) AS total_balance
      FROM membership_billing b WHERE b.member_id = m.member_id
    ) bal ON true
    ${where}
    ORDER BY m.full_name`;
  return { sql, params };
}

router.get('/members', async (req, res) => {
  try {
    const { sql, params } = membersQuery(req.query.search);
    const { rows } = await query(sql, params);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load the member report.' });
  }
});

router.get('/members/export', async (req, res) => {
  try {
    const { sql, params } = membersQuery(req.query.search);
    const { rows } = await query(sql, params);
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Member Report');
    ws.columns = [
      { header: 'MemberID', key: 'member_id', width: 10 },
      { header: 'RegistrationDate', key: 'registration_date', width: 16 },
      { header: 'Name', key: 'name', width: 24 },
      { header: 'Contact', key: 'contact', width: 16 },
      { header: 'Gender', key: 'gender', width: 10 },
      { header: 'Email', key: 'email', width: 26 },
      { header: 'MemberStatus', key: 'member_status', width: 13 },
      { header: 'End_Date', key: 'end_date', width: 13 },
      { header: 'FinalBalance', key: 'final_balance', width: 13 },
    ];
    ws.getRow(1).font = { bold: true };
    for (const r of rows) {
      ws.addRow({ ...r, final_balance: Number(r.final_balance) });
    }
    ws.getColumn('final_balance').numFmt = '#,##0.00';
    await sendWorkbook(res, wb, `member-report-${today()}.xlsx`);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ error: 'Could not export the member report.' });
  }
});

export default router;
