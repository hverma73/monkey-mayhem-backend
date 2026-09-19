import express from 'express';
import { pool, query } from '../db.js';
import { validatePayment, validatePaymentBound, validateCustomPlan, validateDiscount, isPackageAllowedForGender, expectedBalanceConflict } from '../lib/billing.js';
import { business } from '../config/business.js';

const router = express.Router();

const STATUS = { active: 'Active', inactive: 'Inactive' };
const safeName = (s) => String(s || 'member').replace(/[^\w.-]+/g, '_').slice(0, 60);
// Coerce a route/body id to a positive integer, or null (→ clean 400/404).
const toId = (v) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : null);

/* ------------------------------------------------------------------ *
 *  List payment transactions (Payment History / Active / Inactive)
 *  /api/payments?status=all|active|inactive&search=
 * ------------------------------------------------------------------ */
router.get('/', async (req, res) => {
  const { status = 'all', search = '', membership_id } = req.query;
  const params = [];
  const conditions = [];

  if (Object.hasOwn(STATUS, status)) {
    params.push(STATUS[status]);
    conditions.push(`b.membership_status = $${params.length}`);
  }
  if (search) {
    params.push(`%${String(search).toLowerCase()}%`);
    conditions.push(`lower(b.full_name) LIKE $${params.length}`);
  }
  const mid = toId(membership_id);
  if (mid) {
    params.push(mid);
    conditions.push(`pm.membership_id = $${params.length}`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const { rows } = await query(
      `SELECT pm.payment_id, pm.re_no, to_char(pm.paid_on,'YYYY-MM-DD') AS paid_on,
              pm.paid_amount, pm.pay_mode, pm.details, pm.executive,
              b.membership_id, b.invoice_no, b.member_id, b.full_name, b.mobile_no1,
              b.package_name, b.total_amount, b.balance, b.membership_status
       FROM payment pm
       JOIN membership_billing b ON b.membership_id = pm.membership_id
       ${where}
       ORDER BY pm.paid_on DESC, pm.payment_id DESC`,
      params
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load payments.' });
  }
});

// Helper: fetch the billing summary for one membership.
async function billingRow(membershipId) {
  const { rows } = await query('SELECT * FROM membership_billing WHERE membership_id = $1', [membershipId]);
  return rows[0] || null;
}

/* ------------------------------------------------------------------ *
 *  Record a payment against an existing membership
 * ------------------------------------------------------------------ */
router.post('/', async (req, res) => {
  const { membership_id, paid_amount, pay_mode, details, paid_on, expected_balance } = req.body || {};
  const check = validatePayment({ paid_amount, pay_mode, paid_on });
  if (!check.ok) return res.status(400).json({ error: check.error });
  const mid = toId(membership_id);
  if (!mid) return res.status(400).json({ error: 'A membership is required.' });

  // The "Collected ✓" button passes expected_balance = the pending amount it
  // showed. We lock the membership row and re-read the CURRENT balance before
  // inserting, so a concurrent/stale collect can't overpay the invoice into a
  // phantom credit. Ordinary add-payment (no expected_balance) skips this and
  // still allows intentional overpayments.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // FOR UPDATE serialises concurrent settles on the same membership.
    const ms = (await client.query('SELECT id, member_id FROM membership WHERE id = $1 FOR UPDATE', [mid])).rows[0];
    if (!ms) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Membership not found.' }); }

    const bill = (await client.query(
      'SELECT total_amount, balance FROM membership_billing WHERE membership_id = $1', [mid]
    )).rows[0];

    const bound = validatePaymentBound({ paid_amount, total_amount: bill?.total_amount });
    if (!bound.ok) { await client.query('ROLLBACK'); return res.status(400).json({ error: bound.error }); }

    if (expectedBalanceConflict(expected_balance, bill?.balance)) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'This balance changed since the page loaded (someone may have recorded a payment). Refresh and try again.',
      });
    }

    const { rows } = await client.query(
      `INSERT INTO payment (membership_id, member_id, paid_amount, pay_mode, details, executive, paid_on)
       VALUES ($1, $2, $3, COALESCE($4,'Cash'), $5, $6, COALESCE($7::date, CURRENT_DATE))
       RETURNING payment_id, re_no, to_char(paid_on,'YYYY-MM-DD') AS paid_on,
                 paid_amount, pay_mode, details, executive, membership_id, member_id`,
      [ms.id, ms.member_id, paid_amount, pay_mode || null, details || null, req.user?.name || null, paid_on || null]
    );
    await client.query('COMMIT');
    res.status(201).json({ payment: rows[0], billing: await billingRow(ms.id) });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* already gone */ }
    console.error(err);
    res.status(500).json({ error: 'Could not record the payment.' });
  } finally {
    client.release();
  }
});

/* ------------------------------------------------------------------ *
 *  Edit a payment
 * ------------------------------------------------------------------ */
router.put('/:id', async (req, res) => {
  const id = toId(req.params.id);
  if (!id) return res.status(404).json({ error: 'Payment not found.' });
  try {
    const existing = (await query('SELECT * FROM payment WHERE payment_id = $1', [id])).rows[0];
    if (!existing) return res.status(404).json({ error: 'Payment not found.' });

    const merged = {
      paid_amount: req.body?.paid_amount ?? existing.paid_amount,
      // Normalise blank/whitespace to a valid mode (CHECK-constrained column).
      pay_mode: String(req.body?.pay_mode ?? existing.pay_mode).trim() || 'Cash',
      details: req.body?.details ?? existing.details,
      paid_on: req.body?.paid_on ?? existing.paid_on,
    };
    const check = validatePayment(merged);
    if (!check.ok) return res.status(400).json({ error: check.error });

    // Same 10× sanity bound as POST — an edit can fat-finger an amount too.
    const billing = await billingRow(existing.membership_id);
    const bound = validatePaymentBound({ paid_amount: merged.paid_amount, total_amount: billing?.total_amount });
    if (!bound.ok) return res.status(400).json({ error: bound.error });

    const { rows } = await query(
      `UPDATE payment SET paid_amount=$1, pay_mode=$2, details=$3, paid_on=$4::date
       WHERE payment_id=$5
       RETURNING payment_id, re_no, to_char(paid_on,'YYYY-MM-DD') AS paid_on,
                 paid_amount, pay_mode, details, executive, membership_id, member_id`,
      [merged.paid_amount, merged.pay_mode, merged.details, merged.paid_on, id]
    );
    res.json({ payment: rows[0], billing: await billingRow(rows[0].membership_id) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not update the payment.' });
  }
});

/* ------------------------------------------------------------------ *
 *  Delete a payment
 * ------------------------------------------------------------------ */
router.delete('/:id', async (req, res) => {
  const id = toId(req.params.id);
  if (!id) return res.status(404).json({ error: 'Payment not found.' });
  try {
    const result = await query('DELETE FROM payment WHERE payment_id = $1', [id]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Payment not found.' });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not delete the payment.' });
  }
});

/* ------------------------------------------------------------------ *
 *  Custom plan: create a membership (invoice) + an optional first payment
 * ------------------------------------------------------------------ */
router.post('/custom-plan', async (req, res) => {
  const body = req.body || {};
  const check = validateCustomPlan(body);
  if (!check.ok) return res.status(400).json({ error: check.error });

  const { member_id, package_id, start_date, amount, registration_fee, discount, paid_amount, pay_mode, details } = body;
  const start = start_date || new Date().toISOString().slice(0, 10);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Same gender ⇄ package guard as addMembership / edit-period: a gendered
    // plan can only be sold to a member of that gender, even via this endpoint.
    const guard = (await client.query(
      `SELECT m.gender AS member_gender, p.gender AS package_gender, p.name AS package_name, p.price
       FROM member m, package p
       WHERE m.member_id = $1 AND p.package_id = $2`,
      [member_id, package_id]
    )).rows[0];
    if (!guard) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Unknown member or plan.' }); }
    if (!isPackageAllowedForGender(guard.member_gender, guard.package_gender)) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: `The "${guard.package_name}" plan is for ${guard.package_gender} members and can't be assigned to a ${guard.member_gender} member.`,
      });
    }

    // Re-check the discount against the RESOLVED charge (explicit amount, else
    // the plan's list price) so a blank amount can't sneak a negative total in.
    const resolvedAmount = amount != null && amount !== '' ? Number(amount) : Number(guard.price);
    const dv = validateDiscount({ amount: resolvedAmount, registration_fee, discount });
    if (!dv.ok) { await client.query('ROLLBACK'); return res.status(400).json({ error: dv.error }); }

    const ins = await client.query(
      `INSERT INTO membership (member_id, package_id, start_date, end_date, amount, registration_fee, discount)
       SELECT $1, p.package_id, $2::date,
              ($2::date + COALESCE(p.duration_days * INTERVAL '1 day',
                                   (p.duration_months || ' months')::interval))::date,
              COALESCE($3, p.price), COALESCE($4, 0), COALESCE($5, 0)
       FROM package p WHERE p.package_id = $6
       RETURNING id, invoice_no, (COALESCE(amount,0) + registration_fee - discount) AS total_amount`,
      [member_id, start, amount ?? null, registration_fee ?? null, discount ?? null, package_id]
    );
    if (ins.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Unknown plan.' });
    }
    const membershipId = ins.rows[0].id;

    let payment = null;
    if (Number(paid_amount) > 0) {
      // 10× typo guard, same as the standalone payment routes.
      const bound = validatePaymentBound({ paid_amount, total_amount: ins.rows[0].total_amount });
      if (!bound.ok) { await client.query('ROLLBACK'); return res.status(400).json({ error: bound.error }); }
      const pay = await client.query(
        `INSERT INTO payment (membership_id, member_id, paid_amount, pay_mode, details, executive)
         VALUES ($1, $2, $3, COALESCE($4,'Cash'), $5, $6)
         RETURNING payment_id, re_no, to_char(paid_on,'YYYY-MM-DD') AS paid_on,
                   paid_amount, pay_mode, details, executive`,
        [membershipId, member_id, paid_amount, pay_mode || null, details || null, req.user?.name || null]
      );
      payment = pay.rows[0];
    }
    await client.query('COMMIT');
    res.status(201).json({ membership_id: membershipId, invoice_no: ins.rows[0].invoice_no, billing: await billingRow(membershipId), payment });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23503') return res.status(400).json({ error: 'Unknown member or plan.' });
    console.error(err);
    res.status(500).json({ error: 'Could not create the custom plan.' });
  } finally {
    client.release();
  }
});

/* ------------------------------------------------------------------ *
 *  Invoice PDF for one membership
 * ------------------------------------------------------------------ */
router.get('/invoice/:membershipId', async (req, res) => {
  const membershipId = Number(req.params.membershipId);
  try {
    const { rows } = await query(
      `SELECT b.*, (b.end_date - b.start_date) AS duration_days,
              to_char(b.start_date,'DD-MM-YYYY') AS start_fmt,
              to_char(b.end_date,'DD-MM-YYYY')   AS end_fmt,
              to_char(b.created_at,'DD-MM-YYYY') AS invoice_date
       FROM membership_billing b WHERE b.membership_id = $1`,
      [membershipId]
    );
    const b = rows[0];
    if (!b) return res.status(404).json({ error: 'Invoice not found.' });

    const pays = (await query(
      `SELECT re_no, to_char(paid_on,'DD-MM-YYYY') AS paid_on, paid_amount, pay_mode, details, executive
       FROM payment WHERE membership_id = $1 ORDER BY paid_on, payment_id`,
      [membershipId]
    )).rows;

    const data = {
      invoiceNo: b.invoice_no,
      invoiceDate: b.invoice_date,
      member: { name: b.full_name, id: b.member_id, phone: b.mobile_no1, gst: business.gst },
      plan: {
        category: business.discipline,
        name: b.package_name,
        duration: `${b.duration_days} / ${b.duration_days}`,
        dateRange: `${b.start_fmt} - ${b.end_fmt}`,
        time: '',
        instructor: '',
        comment: b.notes || '',
      },
      amounts: {
        amount: b.amount, registrationFee: b.registration_fee, discount: b.discount,
        total: b.total_amount, paid: b.paid_amount, balance: b.balance,
      },
      payments: pays.map((p) => ({
        reNo: p.re_no, date: p.paid_on, subtotal: p.paid_amount, paidAmt: p.paid_amount,
        payMode: p.pay_mode, details: p.details || '', executive: p.executive || '',
      })),
    };

    const filename = `${safeName(b.full_name)}_Invoice_${b.invoice_no}.pdf`;
    const { streamInvoice } = await import('../services/invoicePdf.js');
    streamInvoice(res, data, filename);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ error: 'Could not generate the invoice.' });
  }
});

/* ------------------------------------------------------------------ *
 *  Export the current payments view to .xlsx
 * ------------------------------------------------------------------ */
router.get('/export', async (req, res) => {
  const { status = 'all', search = '' } = req.query;
  const params = [];
  const conditions = [];
  if (Object.hasOwn(STATUS, status)) { params.push(STATUS[status]); conditions.push(`b.membership_status = $${params.length}`); }
  if (search) { params.push(`%${String(search).toLowerCase()}%`); conditions.push(`lower(b.full_name) LIKE $${params.length}`); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const { rows } = await query(
      `SELECT pm.re_no, to_char(pm.paid_on,'YYYY-MM-DD') AS paid_on, b.full_name,
              b.package_name, b.total_amount, pm.paid_amount, b.balance, pm.pay_mode, pm.executive
       FROM payment pm JOIN membership_billing b ON b.membership_id = pm.membership_id
       ${where} ORDER BY pm.paid_on DESC, pm.payment_id DESC`,
      params
    );

    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Payments');
    ws.columns = [
      { header: 'Re No', key: 're_no', width: 10 },
      { header: 'Date', key: 'paid_on', width: 14 },
      { header: 'Member', key: 'full_name', width: 26 },
      { header: 'Package', key: 'package_name', width: 20 },
      { header: 'Total (₹)', key: 'total_amount', width: 14 },
      { header: 'Paid (₹)', key: 'paid_amount', width: 14 },
      { header: 'Balance (₹)', key: 'balance', width: 14 },
      { header: 'Pay Mode', key: 'pay_mode', width: 14 },
      { header: 'Executive', key: 'executive', width: 22 },
    ];
    ws.getRow(1).font = { bold: true };
    for (const r of rows) {
      ws.addRow({
        re_no: r.re_no, paid_on: r.paid_on, full_name: r.full_name, package_name: r.package_name,
        total_amount: Number(r.total_amount), paid_amount: Number(r.paid_amount), balance: Number(r.balance),
        pay_mode: r.pay_mode, executive: r.executive,
      });
    }
    ['total_amount', 'paid_amount', 'balance'].forEach((k) => {
      ws.getColumn(k).numFmt = '#,##0.00';
    });

    const today = new Date().toISOString().slice(0, 10);
    // Derive the filename label from the validated map, never raw query input
    // (which would let a quote/semicolon into the Content-Disposition header).
    const label = Object.hasOwn(STATUS, status) ? status : 'all';
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="payments-${label}-${today}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ error: 'Could not export payments.' });
  }
});

export default router;
