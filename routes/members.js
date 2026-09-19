import express from 'express';
import { pool, query } from '../db.js';
import { pauseBudgetForPlan, validatePauseStart, cappedPauseDays, validatePauseCoverage, isPackageAllowedForGender, validatePaymentBound } from '../lib/billing.js';
import { formatMembershipNo, expiryWindowDays } from '../lib/members.js';

const router = express.Router();

// Coerce a route id to a positive integer, or null (→ clean 404 instead of a
// pg error / 500 on garbage like /members/abc). Mirrors payments.js.
const toId = (v) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : null);

/* ------------------------------------------------------------------ *
 *  Packages (price list)
 * ------------------------------------------------------------------ */
router.get('/packages', async (req, res) => {
  const { gender } = req.query;

  // A gender narrows the catalogue to that gender's plans plus the unisex
  // ('All') plans. No gender returns the whole active catalogue (the member
  // form). An unrecognised gender is rejected rather than silently widened.
  try {
    if (gender) {
      if (!['Male', 'Female', 'Other'].includes(gender)) {
        return res.status(400).json({ error: 'Invalid gender.' });
      }
      const { rows } = await query(
        `SELECT package_id, name, duration_months, duration_days, price, gender
         FROM package
         WHERE is_active AND (gender = $1 OR gender = 'All')
         ORDER BY COALESCE(duration_days, duration_months * 30)`,
        [gender]
      );
      return res.json(rows);
    }

    const { rows } = await query(
      `SELECT package_id, name, duration_months, duration_days, price, gender
       FROM package WHERE is_active ORDER BY COALESCE(duration_days, duration_months * 30)`
    );
    res.json(rows);
  } catch (err) {
    // Express 4 doesn't catch async throws — without this the request hangs.
    console.error(err);
    res.status(500).json({ error: 'Could not load packages.' });
  }
});

/* ------------------------------------------------------------------ *
 *  Create a custom package plan (used by the Custom Package Plan page)
 * ------------------------------------------------------------------ */
router.post('/packages', async (req, res) => {
  // Custom plans are DAY-based (10-day trial, 45 days, ...). duration_months
  // is still accepted for scripted/legacy callers — exactly one of the two.
  const { name, duration_months, duration_days, price, gender = 'All' } = req.body || {};
  const amount = Number(price);
  const hasDays = duration_days != null && duration_days !== '';
  const hasMonths = duration_months != null && duration_months !== '';
  const days = hasDays ? Number(duration_days) : null;
  const months = hasMonths ? Number(duration_months) : null;

  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Package name is required.' });
  }
  if (hasDays === hasMonths) {
    return res.status(400).json({ error: 'Give the duration in days (or months) — exactly one.' });
  }
  if (hasDays && (!Number.isInteger(days) || days <= 0)) {
    return res.status(400).json({ error: 'Duration must be a whole number of days greater than 0.' });
  }
  if (hasMonths && (!Number.isInteger(months) || months <= 0)) {
    return res.status(400).json({ error: 'Duration must be a whole number of months greater than 0.' });
  }
  if (!Number.isFinite(amount) || amount < 0) {
    return res.status(400).json({ error: 'Price must be 0 or more.' });
  }
  if (!['Male', 'Female', 'Other', 'All'].includes(gender)) {
    return res.status(400).json({ error: 'Invalid gender.' });
  }

  try {
    const { rows } = await query(
      `INSERT INTO package (name, duration_months, duration_days, price, gender)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING package_id, name, duration_months, duration_days, price, gender`,
      [name.trim(), months, days, amount, gender]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'A package with that name already exists.' });
    }
    console.error(err);
    res.status(500).json({ error: 'Could not create the package.' });
  }
});

/* ------------------------------------------------------------------ *
 *  Dashboard stats
 * ------------------------------------------------------------------ */
router.get('/stats', async (_req, res) => {
  try {
    const { rows } = await query(`
      SELECT
        count(*)                                              AS total,
        count(*) FILTER (WHERE status = 'Active')             AS active,
        count(*) FILTER (WHERE status = 'Inactive')           AS inactive,
        count(*) FILTER (WHERE days_to_expiry BETWEEN 0 AND 7) AS expiring_week,
        -- Revenue = money received within the current calendar month, from the
        -- payment ledger. Bounded both sides so a future-dated receipt can't be
        -- counted now and again when its month arrives.
        ( SELECT COALESCE(SUM(p.paid_amount), 0) FROM payment p
           WHERE p.paid_on >= date_trunc('month', CURRENT_DATE)
             AND p.paid_on <  date_trunc('month', CURRENT_DATE) + interval '1 month' ) AS revenue_this_month
      FROM member_overview
    `);
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load dashboard stats.' });
  }
});

/* ------------------------------------------------------------------ *
 *  Expiring soon (default: next 7 days, PLUS the last 7 days of lapses)
 * ------------------------------------------------------------------ */
// Shared by the JSON list and the .xlsx export so both show the same fighters.
// days_to_expiry reflects the RUNNING period's expiry (see member_overview), so a
// member whose active plan lapses soon still surfaces here even if they already
// queued a renewal — upcoming_count lets the UI mark that.
// The window looks BACK 7 days too: a member who lapsed yesterday still needs a
// renewal call, and dropping them the moment they expire meant nobody chased
// them. The UI already renders negative days as "Xd ago".
const EXPIRED_LOOKBACK_DAYS = 7;
async function expiringRows(days) {
  const { rows } = await query(
    `SELECT member_id, full_name, mobile_no1, package_name,
            to_char(end_date,'YYYY-MM-DD') AS end_date,
            days_to_expiry, status, upcoming_count
     FROM member_overview
     WHERE days_to_expiry IS NOT NULL AND days_to_expiry BETWEEN -${EXPIRED_LOOKBACK_DAYS} AND $1
     ORDER BY days_to_expiry ASC`,
    [expiryWindowDays(days)]
  );
  return rows;
}

router.get('/expiring', async (req, res) => {
  try {
    res.json(await expiringRows(req.query.days));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load expiring memberships.' });
  }
});

/* ------------------------------------------------------------------ *
 *  Weekly "On the Ropes" report — expiring members as an .xlsx, with a
 *  deliberately blank "Paid" column for staff to fill in during collection.
 * ------------------------------------------------------------------ */
router.get('/expiring/export', async (req, res) => {
  try {
    const rows = await expiringRows(req.query.days);
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Expiring Memberships');
    ws.columns = [
      { header: 'Member', key: 'full_name', width: 26 },
      { header: 'Phone', key: 'mobile_no1', width: 16 },
      { header: 'Package', key: 'package_name', width: 16 },
      { header: 'Expires', key: 'end_date', width: 13 },
      { header: 'Days Left', key: 'days_left', width: 10 },
      { header: 'Paid', key: 'paid', width: 14 },               // left blank — filled in on collection
      { header: 'Amount Paid', key: 'amount_paid', width: 14 }, // left blank — filled in on collection
    ];
    ws.getRow(1).font = { bold: true };
    for (const r of rows) {
      ws.addRow({
        full_name: r.full_name,
        mobile_no1: r.mobile_no1,
        package_name: r.package_name || '',
        end_date: r.end_date,
        days_left: Number(r.days_to_expiry),
        paid: null,        // blank cell for manual entry
        amount_paid: null, // blank cell for manual entry
      });
    }
    // Format the (empty) money columns as currency so typed amounts render nicely.
    ws.getColumn('paid').numFmt = '#,##0.00';
    ws.getColumn('amount_paid').numFmt = '#,##0.00';

    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="expiring-report-${stamp}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ error: 'Could not export the expiring report.' });
  }
});

/* ------------------------------------------------------------------ *
 *  Calendar - expiries within a given month
 *  /api/members/calendar?year=2026&month=6   (month is 1-12)
 * ------------------------------------------------------------------ */
router.get('/calendar', async (req, res) => {
  const year = Number(req.query.year);
  const month = Number(req.query.month);
  if (!year || !month) {
    return res.status(400).json({ error: 'Provide year and month.' });
  }
  // Read per-period (membership_billing), not member_overview: a member can now
  // have several periods (running + queued), and the calendar must plot every
  // period's expiry, not just the one the overview picks.
  //
  // But drop a SUPERSEDED past expiry: when a member has renewed (a later period
  // whose end_date is after this one's), the old expired date is stale noise, so
  // we hide it and keep only the renewed/upcoming expiry. A member who genuinely
  // lapsed with no renewal still shows — the NOT EXISTS only fires when a later
  // period exists for the same member.
  try {
    const { rows } = await query(
      `SELECT mb.member_id, mb.full_name, mb.package_name,
              to_char(mb.end_date,'YYYY-MM-DD') AS end_date
       FROM membership_billing mb
       WHERE mb.end_date IS NOT NULL
         AND date_part('year', mb.end_date) = $1
         AND date_part('month', mb.end_date) = $2
         AND NOT (
           mb.period_phase = 'past'
           AND EXISTS (
             SELECT 1 FROM membership_billing later
             WHERE later.member_id = mb.member_id
               AND later.end_date > mb.end_date
           )
         )
       ORDER BY mb.end_date`,
      [year, month]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load the calendar.' });
  }
});

/* ------------------------------------------------------------------ *
 *  List members  (search by name + status filter)
 *  /api/members?search=bru&status=Active
 * ------------------------------------------------------------------ */
router.get('/', async (req, res) => {
  const { search = '', status = '' } = req.query;
  const conditions = [];
  const params = [];

  if (search) {
    params.push(`%${search.toLowerCase()}%`);
    conditions.push(`lower(full_name) LIKE $${params.length}`);
  }
  if (status && ['Active', 'Upcoming', 'Paused', 'Inactive', 'No Plan'].includes(status)) {
    params.push(status);
    conditions.push(`status = $${params.length}`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  try {
    const { rows } = await query(
      `SELECT member_id, full_name, age, gender, mobile_no1, email, blood_group,
              membership_no, package_name, start_date, end_date, days_to_expiry,
              status, photo_url
       FROM member_overview ${where}
       ORDER BY full_name`,
      params
    );
    // Fall back to the derived membership number for any legacy row that never had
    // one persisted, so the roster shows a number for every member.
    res.json(rows.map((r) => ({ ...r, membership_no: r.membership_no || formatMembershipNo(r.member_id) })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load members.' });
  }
});

/* ------------------------------------------------------------------ *
 *  Full detail for one member (all related tables)
 * ------------------------------------------------------------------ */
router.get('/:id', async (req, res) => {
  const id = toId(req.params.id);
  if (!id) return res.status(404).json({ error: 'Member not found.' });
  try {
    const member = (await query('SELECT * FROM member WHERE member_id = $1', [id])).rows[0];
    if (!member) return res.status(404).json({ error: 'Member not found.' });

    const [emergency, guardians, office, memberships, anchor] = await Promise.all([
      query('SELECT * FROM emergency_contact WHERE member_id = $1', [id]),
      query('SELECT * FROM guardian WHERE member_id = $1', [id]),
      query('SELECT * FROM office_use WHERE member_id = $1', [id]),
      // Read from the billing view so each period carries total/paid/balance and
      // period_phase (past/current/upcoming, computed server-side).
      query(
        `SELECT * FROM membership_billing WHERE member_id = $1 ORDER BY end_date DESC`,
        [id]
      ),
      // Where a new stacked period would land: the furthest not-yet-expired
      // end_date, else today. Lets the renew form prefill the default start.
      query(
        `SELECT to_char(GREATEST(COALESCE(MAX(end_date), CURRENT_DATE), CURRENT_DATE), 'YYYY-MM-DD') AS next_start_date
         FROM membership WHERE member_id = $1 AND end_date >= CURRENT_DATE`,
        [id]
      ),
    ]);

    // Always surface a membership number: persisted value if any, else derived
    // from the id (covers legacy members created before auto-numbering).
    const officeRow = office.rows[0] || {};
    res.json({
      member,
      emergencyContacts: emergency.rows,
      guardians: guardians.rows,
      office: { ...officeRow, membership_no: officeRow.membership_no || formatMembershipNo(id) },
      memberships: memberships.rows,
      next_start_date: anchor.rows[0]?.next_start_date || null,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load the member.' });
  }
});

/* ------------------------------------------------------------------ *
 *  Helpers shared by create / update
 * ------------------------------------------------------------------ */
async function insertMember(client, m) {
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
  return rows[0].member_id;
}

async function insertChildren(client, memberId, { emergencyContacts = [], guardians = [], office, membership }, executive = null) {
  for (const ec of emergencyContacts) {
    if (!ec || !ec.name) continue;
    await client.query(
      `INSERT INTO emergency_contact (member_id, name, relationship, phone, address)
       VALUES ($1,$2,$3,$4,$5)`,
      [memberId, ec.name, ec.relationship || null, ec.phone || null, ec.address || null]
    );
  }
  for (const g of guardians) {
    if (!g || !g.name) continue;
    await client.query(
      `INSERT INTO guardian (member_id, name, relationship, mobile_number)
       VALUES ($1,$2,$3,$4)`,
      [memberId, g.name, g.relationship || null, g.mobile_number || null]
    );
  }
  // The membership/card number is auto-derived from member_id (unique + stable),
  // never typed by staff. Always ensure an office_use row exists so every member
  // carries one, and assign the number ONCE — COALESCE keeps any existing value
  // so an edit never changes it (and legacy/imported numbers are preserved).
  const o = office || {};
  await client.query(
    `INSERT INTO office_use (member_id, membership_no, batch, trainer,
        date_of_joining, id_verified, medical_reviewed, staff_name, staff_signature)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (member_id) DO UPDATE SET
        membership_no = COALESCE(office_use.membership_no, EXCLUDED.membership_no),
        batch = EXCLUDED.batch,
        trainer = EXCLUDED.trainer, date_of_joining = EXCLUDED.date_of_joining,
        id_verified = EXCLUDED.id_verified, medical_reviewed = EXCLUDED.medical_reviewed,
        staff_name = EXCLUDED.staff_name, staff_signature = EXCLUDED.staff_signature`,
    [memberId, formatMembershipNo(memberId), o.batch || null, o.trainer || null,
     o.date_of_joining || null, !!o.id_verified, !!o.medical_reviewed,
     o.staff_name || null, o.staff_signature || null]
  );
  if (membership && membership.package_id) {
    await addMembership(client, memberId, membership, executive);
  }
}

// Adds one membership period; end_date + charge are derived from the package.
// The paid amount (defaulting to the full price) is also recorded as a payment
// receipt so it shows up on the Payments tab and the invoice.
//
// Stacking: when start_date is left blank AND the member still has coverage, the
// new period ABUTS the furthest not-yet-expired end_date (so total expiry
// extends and no paid time is lost); with no coverage it starts today. An
// explicit start_date is used verbatim (staff may backdate or schedule). The
// anchor is computed in SQL so it stays correct inside the transaction.
async function addMembership(client, memberId, membership, executive = null) {
  // Enforce the gender ⇄ package mapping at write time: a gendered plan can only
  // be sold to a member of that gender (unisex 'All' plans go to anyone). Mirrors
  // the GET /packages?gender= catalogue so the API can't be steered past the UI.
  const guard = (await client.query(
    `SELECT m.gender AS member_gender, p.gender AS package_gender, p.name AS package_name
     FROM member m, package p
     WHERE m.member_id = $1 AND p.package_id = $2`,
    [memberId, membership.package_id]
  )).rows[0];
  if (!guard) {
    const err = new Error('Unknown member or plan.');
    err.status = 400;
    throw err;
  }
  if (!isPackageAllowedForGender(guard.member_gender, guard.package_gender)) {
    const err = new Error(
      `The "${guard.package_name}" plan is for ${guard.package_gender} members and can't be assigned to a ${guard.member_gender} member.`
    );
    err.status = 400;
    throw err;
  }

  const { rows } = await client.query(
    `WITH anchor AS (
       SELECT COALESCE(
                $2::date,
                GREATEST(COALESCE(MAX(m2.end_date), CURRENT_DATE), CURRENT_DATE)
              ) AS start_date
       FROM membership m2
       WHERE m2.member_id = $1 AND m2.end_date >= CURRENT_DATE
     )
     INSERT INTO membership (member_id, package_id, start_date, end_date, amount_paid, amount)
     SELECT $1, p.package_id,
            a.start_date,
            (a.start_date + COALESCE(p.duration_days * INTERVAL '1 day',
                                     (p.duration_months || ' months')::interval))::date,
            COALESCE($3, p.price), p.price
     FROM package p, anchor a
     WHERE p.package_id = $4
     RETURNING id, amount_paid, amount, to_char(start_date, 'YYYY-MM-DD') AS start_date,
               to_char(end_date, 'YYYY-MM-DD') AS end_date`,
    [memberId, membership.start_date || null,
     membership.amount_paid ?? null, membership.package_id]
  );
  const row = rows[0];
  if (row && Number(row.amount_paid) > 0) {
    // Same 10× typo guard the Payments tab applies — a fat-fingered first
    // payment must not slip in through renew/create either.
    const bound = validatePaymentBound({ paid_amount: row.amount_paid, total_amount: row.amount });
    if (!bound.ok) { const e = new Error(bound.error); e.status = 400; throw e; }
    await client.query(
      `INSERT INTO payment (membership_id, member_id, paid_amount, pay_mode, executive)
       VALUES ($1, $2, $3, 'Cash', $4)`,
      [row.id, memberId, row.amount_paid, executive]
    );
  }
  return row;
}

/* ------------------------------------------------------------------ *
 *  Create member (one transaction across all tables)
 * ------------------------------------------------------------------ */
router.post('/', async (req, res) => {
  const { member } = req.body;
  if (!member || !member.full_name || !member.mobile_no1) {
    return res.status(400).json({ error: 'Full name and mobile number are required.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const memberId = await insertMember(client, member);
    await insertChildren(client, memberId, req.body, req.user?.name);
    await client.query('COMMIT');
    res.status(201).json({ member_id: memberId });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.status === 400) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Could not save the member.' });
  } finally {
    client.release();
  }
});

/* ------------------------------------------------------------------ *
 *  Update member (replaces child rows; memberships are managed via /renew)
 * ------------------------------------------------------------------ */
router.put('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const { member, emergencyContacts = [], guardians = [], office } = req.body;
  if (!member || !member.full_name || !member.mobile_no1) {
    return res.status(400).json({ error: 'Full name and mobile number are required.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE member SET full_name=$1, date_of_birth=$2, gender=$3, address=$4,
         mobile_no1=$5, mobile_no2=$6, email=$7, occupation=$8, blood_group=$9,
         height_cm=$10, weight_kg=$11, id_proof_no=$12, photo_url=$13, updated_at=now()
       WHERE member_id=$14`,
      [member.full_name, member.date_of_birth || null, member.gender || null,
       member.address || null, member.mobile_no1, member.mobile_no2 || null,
       member.email || null, member.occupation || null, member.blood_group || null,
       member.height_cm || null, member.weight_kg || null, member.id_proof_no || null,
       member.photo_url || null, id]
    );

    // Simplest reliable approach: clear and re-insert the multi-row children.
    await client.query('DELETE FROM emergency_contact WHERE member_id = $1', [id]);
    await client.query('DELETE FROM guardian WHERE member_id = $1', [id]);
    await insertChildren(client, id, { emergencyContacts, guardians, office });

    await client.query('COMMIT');
    res.json({ member_id: id });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Could not update the member.' });
  } finally {
    client.release();
  }
});

/* ------------------------------------------------------------------ *
 *  Renew / add a membership period
 * ------------------------------------------------------------------ */
router.post('/:id/renew', async (req, res) => {
  const id = Number(req.params.id);
  const { package_id, start_date, amount_paid } = req.body;
  if (!package_id) return res.status(400).json({ error: 'Pick a package.' });

  const client = await pool.connect();
  try {
    // Now writes two rows (membership + payment), so wrap in a transaction.
    await client.query('BEGIN');
    const row = await addMembership(client, id, { package_id, start_date, amount_paid }, req.user?.name);
    await client.query('COMMIT');
    // Echo the computed window so the UI can confirm where a stacked period landed.
    res.status(201).json({ ok: true, start_date: row?.start_date, end_date: row?.end_date });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.status === 400) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Could not renew the membership.' });
  } finally {
    client.release();
  }
});

/* ------------------------------------------------------------------ *
 *  Edit one membership period (a renewal / stacked period)
 *  PUT /api/members/:id/membership/:membershipId
 *
 *  Staff can change the package, start date, and the plan charge (amount).
 *  end_date is RECOMPUTED from the (possibly new) package's duration + the
 *  start date — mirroring addMembership so a period never drifts from its
 *  plan length. A blank start_date re-stacks: it abuts the furthest OTHER
 *  not-yet-expired period (this period excluded so it doesn't anchor on
 *  itself), else today. Payment receipts are NOT touched — they are managed
 *  on the Payments tab and remain authoritative for the balance.
 * ------------------------------------------------------------------ */
router.put('/:id/membership/:membershipId', async (req, res) => {
  const id = Number(req.params.id);
  const membershipId = Number(req.params.membershipId);
  const { package_id, start_date, amount } = req.body || {};
  if (!Number.isInteger(id) || !Number.isInteger(membershipId)) {
    return res.status(404).json({ error: 'Membership not found.' });
  }
  if (!package_id) return res.status(400).json({ error: 'Pick a package.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // The period must belong to this member (prevents editing another member's
    // period by guessing its id). Lock the row for the duration of the update.
    const existing = (await client.query(
      'SELECT id FROM membership WHERE id = $1 AND member_id = $2 FOR UPDATE',
      [membershipId, id]
    )).rows[0];
    if (!existing) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Membership not found for this member.' }); }

    // Same gender ⇄ package guard as addMembership: a gendered plan can only be
    // assigned to a member of that gender (unisex 'All' plans go to anyone).
    const guard = (await client.query(
      `SELECT m.gender AS member_gender, p.gender AS package_gender, p.name AS package_name
       FROM member m, package p
       WHERE m.member_id = $1 AND p.package_id = $2`,
      [id, package_id]
    )).rows[0];
    if (!guard) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Unknown member or plan.' }); }
    if (!isPackageAllowedForGender(guard.member_gender, guard.package_gender)) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: `The "${guard.package_name}" plan is for ${guard.package_gender} members and can't be assigned to a ${guard.member_gender} member.`,
      });
    }

    // Recompute start (blank re-stacks behind OTHER live periods, self excluded)
    // and end (start + new package duration). amount: explicit value else plan price.
    const { rows } = await client.query(
      `WITH anchor AS (
         SELECT COALESCE(
                  $3::date,
                  GREATEST(COALESCE(MAX(m2.end_date), CURRENT_DATE), CURRENT_DATE)
                ) AS start_date
         FROM membership m2
         WHERE m2.member_id = $1 AND m2.id <> $2 AND m2.end_date >= CURRENT_DATE
       )
       UPDATE membership ms
       SET package_id = p.package_id,
           start_date = a.start_date,
           -- start + new plan length + any frozen days already credited by
           -- resumed pauses. Without the pause term, re-saving a period would
           -- silently erase time the member earned back on resume (while the
           -- pause budget still counts those days as used).
           end_date   = (a.start_date
                         + COALESCE(p.duration_days * INTERVAL '1 day',
                                    (p.duration_months || ' months')::interval)
                         + (COALESCE((SELECT SUM(mp.days) FROM membership_pause mp
                                       WHERE mp.membership_id = ms.id AND mp.resume_date IS NOT NULL), 0)
                            * INTERVAL '1 day'))::date,
           amount     = COALESCE($4, p.price),
           amount_paid = COALESCE($4, p.price)               -- keep legacy column aligned with the charge
       FROM package p, anchor a
       WHERE ms.id = $2 AND p.package_id = $5
       RETURNING ms.id,
                 to_char(ms.start_date,'YYYY-MM-DD') AS start_date,
                 to_char(ms.end_date,'YYYY-MM-DD')   AS end_date`,
      [id, membershipId, start_date || null,
       amount != null && amount !== '' ? Number(amount) : null, package_id]
    );

    await client.query('COMMIT');
    // Receipts are untouched by design, so a re-priced period can now carry a
    // credit or a due. Return the fresh billing summary so the UI can surface
    // that immediately instead of leaving staff to discover it on the invoice.
    const billing = (await query(
      'SELECT total_amount, paid_amount, balance FROM membership_billing WHERE membership_id = $1',
      [membershipId]
    )).rows[0] || null;
    res.json({ ok: true, membership_id: membershipId, start_date: rows[0]?.start_date, end_date: rows[0]?.end_date, billing });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Could not update the membership period.' });
  } finally {
    client.release();
  }
});

/* ------------------------------------------------------------------ *
 *  Delete one membership period (a renewal / stacked period)
 *  DELETE /api/members/:id/membership/:membershipId
 *
 *  Removes the period. Its payment receipts and any pause records are removed
 *  too via ON DELETE CASCADE (payment.membership_id, membership_pause.membership_id).
 *  The confirmation warning about lost receipts lives in the UI.
 * ------------------------------------------------------------------ */
router.delete('/:id/membership/:membershipId', async (req, res) => {
  const id = Number(req.params.id);
  const membershipId = Number(req.params.membershipId);
  if (!Number.isInteger(id) || !Number.isInteger(membershipId)) {
    return res.status(404).json({ error: 'Membership not found.' });
  }
  try {
    // Scope the delete to this member so a period can't be removed by guessing
    // its id under the wrong member. rowCount tells us whether it matched.
    const { rowCount } = await query(
      'DELETE FROM membership WHERE id = $1 AND member_id = $2',
      [membershipId, id]
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Membership not found for this member.' });
    res.json({ ok: true, membership_id: membershipId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not delete the membership period.' });
  }
});

/* ------------------------------------------------------------------ *
 *  Membership pause / resume — staff-initiated, budget by plan length.
 *  Pause = freeze now (open). Resume = unfreeze and add the frozen days
 *  back to end_date. Budget (pauseBudgetForPlan) caps total frozen days.
 * ------------------------------------------------------------------ */
// Pause budget + usage for the membership pause should act on: the one with an
// OPEN pause (a frozen period's end_date is stale and may sit in the past), else
// the period covering today, else the most recent — so Resume is always
// reachable and Pause targets the running plan, never a queued/upcoming one.
async function pauseInfoFor(memberId) {
  const ms = (await query(
    `SELECT membership_id, duration_months, duration_days, membership_status,
            to_char(end_date,'YYYY-MM-DD') AS end_date
     FROM membership_billing mb
     WHERE member_id = $1
     ORDER BY
       (EXISTS (SELECT 1 FROM membership_pause mp
                WHERE mp.membership_id = mb.membership_id AND mp.resume_date IS NULL)) DESC,
       (mb.start_date <= CURRENT_DATE AND mb.end_date >= CURRENT_DATE) DESC,
       mb.end_date DESC
     LIMIT 1`,
    [memberId]
  )).rows[0];
  if (!ms) return null;
  const budget = pauseBudgetForPlan(ms);
  // Used = frozen days from already-resumed pauses (open pause's days is NULL).
  const used = Number((await query(
    'SELECT COALESCE(SUM(days),0) AS used FROM membership_pause WHERE membership_id = $1 AND resume_date IS NOT NULL',
    [ms.membership_id]
  )).rows[0].used);
  const open = (await query(
    `SELECT pause_id, to_char(pause_start,'YYYY-MM-DD') AS pause_start,
            (CURRENT_DATE - pause_start) AS accrued_days, planned_days,
            to_char(pause_start + planned_days, 'YYYY-MM-DD') AS expected_resume, reason
     FROM membership_pause WHERE membership_id = $1 AND resume_date IS NULL`,
    [ms.membership_id]
  )).rows[0] || null;
  const pauses = (await query(
    `SELECT pause_id, to_char(pause_start,'YYYY-MM-DD') AS pause_start,
            to_char(resume_date,'YYYY-MM-DD') AS resume_date, days, reason, created_by
     FROM membership_pause WHERE membership_id = $1 ORDER BY pause_start, pause_id`,
    [ms.membership_id]
  )).rows;
  return {
    membership_id: ms.membership_id,
    membership_status: ms.membership_status,
    end_date: ms.end_date,
    duration_months: ms.duration_months,
    duration_days: ms.duration_days,
    budget,
    used,
    remaining: budget - used,
    open_pause: open
      ? {
          pause_id: open.pause_id,
          pause_start: open.pause_start,
          accrued_days: Number(open.accrued_days),
          planned_days: open.planned_days,
          expected_resume: open.expected_resume,
          reason: open.reason,
        }
      : null,
    pauses,
  };
}

router.get('/:id/pause-info', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(404).json({ error: 'Member not found.' });
  try {
    const info = await pauseInfoFor(id);
    if (!info) return res.status(404).json({ error: 'No membership to pause.' });
    res.json(info);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load pause info.' });
  }
});

// Pause = open a freeze now (no preset length). end_date is untouched until resume.
router.post('/:id/pause', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(404).json({ error: 'Member not found.' });
  const { reason, days } = req.body || {};

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // At most one open freeze per member (also enforced by a partial unique
    // index). Refuse up front so a drifted/stacked period can't be double-paused.
    const alreadyOpen = (await client.query(
      'SELECT 1 FROM membership_pause WHERE member_id = $1 AND resume_date IS NULL LIMIT 1',
      [id]
    )).rows[0];
    if (alreadyOpen) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Membership is already paused.' }); }

    // Pause the period that is RUNNING today, never a queued/upcoming one.
    const ms = (await client.query(
      `SELECT ms.id, p.duration_months, p.duration_days,
              to_char(ms.start_date,'YYYY-MM-DD') AS start_date,
              to_char(ms.end_date,'YYYY-MM-DD')   AS end_date,
              to_char(CURRENT_DATE,'YYYY-MM-DD')  AS today
       FROM membership ms JOIN package p ON p.package_id = ms.package_id
       WHERE ms.member_id = $1 AND ms.start_date <= CURRENT_DATE AND ms.end_date >= CURRENT_DATE
       ORDER BY ms.end_date DESC LIMIT 1 FOR UPDATE OF ms`,
      [id]
    )).rows[0];
    if (!ms) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'No running membership to pause.' }); }

    // Defence-in-depth: the selection already covers today (DB CURRENT_DATE),
    // re-check with the same date so JS and SQL never disagree.
    const coverage = validatePauseCoverage({ start_date: ms.start_date, end_date: ms.end_date, today: ms.today });
    if (!coverage.ok) { await client.query('ROLLBACK'); return res.status(400).json({ error: coverage.error }); }

    const budget = pauseBudgetForPlan(ms);
    const used = Number((await client.query(
      'SELECT COALESCE(SUM(days),0) AS used FROM membership_pause WHERE membership_id = $1 AND resume_date IS NOT NULL', [ms.id]
    )).rows[0].used);
    const membershipStatus = (await client.query(
      'SELECT membership_status FROM membership_billing WHERE membership_id = $1', [ms.id]
    )).rows[0]?.membership_status;

    const check = validatePauseStart({ membershipStatus, remaining: budget - used, plannedDays: days });
    if (!check.ok) { await client.query('ROLLBACK'); return res.status(400).json({ error: check.error }); }

    await client.query(
      `INSERT INTO membership_pause (membership_id, member_id, pause_start, planned_days, reason, created_by)
       VALUES ($1, $2, CURRENT_DATE, $3, $4, $5)`,
      [ms.id, id, days ? Number(days) : null, reason || null, req.user?.name || null]
    );
    await client.query('COMMIT');
    res.status(201).json({ ok: true, pause_info: await pauseInfoFor(id) });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') return res.status(409).json({ error: 'Membership is already paused.' });
    console.error(err);
    res.status(500).json({ error: 'Could not pause the membership.' });
  } finally {
    client.release();
  }
});

// Resume = close the open pause; add the frozen days (capped at budget) to end_date.
router.post('/:id/resume', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(404).json({ error: 'Member not found.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const open = (await client.query(
      `SELECT mp.pause_id, mp.membership_id, mp.planned_days,
              (CURRENT_DATE - mp.pause_start) AS elapsed, p.duration_months, p.duration_days
       FROM membership_pause mp
       JOIN membership ms ON ms.id = mp.membership_id
       JOIN package p ON p.package_id = ms.package_id
       WHERE mp.member_id = $1 AND mp.resume_date IS NULL
       ORDER BY mp.pause_start DESC LIMIT 1 FOR UPDATE OF mp, ms`,
      [id]
    )).rows[0];
    if (!open) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Membership is not paused.' }); }

    const budget = pauseBudgetForPlan(open);
    const used = Number((await client.query(
      'SELECT COALESCE(SUM(days),0) AS used FROM membership_pause WHERE membership_id = $1 AND resume_date IS NOT NULL', [open.membership_id]
    )).rows[0].used);
    // Credit elapsed days, capped at the remaining budget and (if set) the planned length.
    const cap = open.planned_days ? Math.min(budget - used, Number(open.planned_days)) : budget - used;
    const applied = cappedPauseDays(open.elapsed, cap);

    await client.query('UPDATE membership_pause SET resume_date = CURRENT_DATE, days = $1 WHERE pause_id = $2', [applied, open.pause_id]);
    if (applied > 0) {
      await client.query('UPDATE membership SET end_date = end_date + $1::int WHERE id = $2', [applied, open.membership_id]);
    }
    await client.query('COMMIT');
    res.json({ ok: true, applied_days: applied, pause_info: await pauseInfoFor(id) });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Could not resume the membership.' });
  } finally {
    client.release();
  }
});

// Delete/undo a pause record. Reverses any frozen days it had applied
// (an open, not-yet-resumed pause applied none, so end_date is unchanged).
// Known limitation: if a later period was stacked AFTER this one's
// pause-extended end_date, undoing the pause shrinks end_date and can open a
// small gap before the queued period. Rare (undo a resumed pause on a since-
// renewed member); left as-is to keep the undo simple and reversible.
router.delete('/:id/pause/:pauseId', async (req, res) => {
  const id = Number(req.params.id);
  const pauseId = Number(req.params.pauseId);
  if (!Number.isInteger(id) || !Number.isInteger(pauseId)) return res.status(404).json({ error: 'Pause not found.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const p = (await client.query(
      `SELECT membership_id, COALESCE(days,0) AS days FROM membership_pause
       WHERE pause_id = $1 AND member_id = $2 FOR UPDATE`,
      [pauseId, id]
    )).rows[0];
    if (!p) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Pause not found.' }); }

    if (Number(p.days) > 0) {
      await client.query('UPDATE membership SET end_date = end_date - $1::int WHERE id = $2', [p.days, p.membership_id]);
    }
    await client.query('DELETE FROM membership_pause WHERE pause_id = $1', [pauseId]);
    await client.query('COMMIT');
    res.json({ ok: true, pause_info: await pauseInfoFor(id) });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Could not remove the pause.' });
  } finally {
    client.release();
  }
});

/* ------------------------------------------------------------------ *
 *  Delete member (cascades to all child tables)
 * ------------------------------------------------------------------ */
router.delete('/:id', async (req, res) => {
  const id = toId(req.params.id);
  if (!id) return res.status(404).json({ error: 'Member not found.' });
  try {
    const result = await query('DELETE FROM member WHERE member_id = $1', [id]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Member not found.' });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not delete the member.' });
  }
});

export default router;
