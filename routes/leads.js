import express from 'express';
import { query } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { cleanLeadInput } from '../lib/leads.js';

const router = express.Router();

// ---------------------------------------------------------------------
// Casual-spam brake for POST /, the app's only public write endpoint.
// ---------------------------------------------------------------------
// Deliberately dependency-free and deliberately modest: a fixed window per IP,
// held in memory. Be clear about what it does NOT do —
//   * it resets on every restart,
//   * it is per-process, so it does nothing across replicas,
//   * server.js sets no `trust proxy`, so behind a reverse proxy req.ip is the
//     PROXY's address and this degrades into one global limit.
// It raises the cost of a bored someone hammering the form, nothing more. If
// real spam ever shows up the answers are a captcha, a rate limit at the proxy,
// or provider-side filtering — not a bigger Map.
// A token bucket rather than a fixed window: BURST submissions are available
// immediately and one more comes back every REFILL_MS. A window would refuse
// the whole of the next window once tripped, which is a poor outcome for the
// realistic false positive here — several people joining together from one
// office or college wifi, who share a single NAT address.
const BURST = 5;
const REFILL_MS = 2 * 60 * 1000; // one more submission every two minutes
const MAX_TRACKED_IPS = 5000;    // bound the map so it can't grow unchecked

const buckets = new Map(); // ip -> { tokens, last }

function throttled(ip) {
  const now = Date.now();
  const seen = buckets.get(ip);

  if (!seen) {
    // Sweep fully-refilled (i.e. idle) entries before adding a new one, so a
    // long tail of one-off visitors can't accumulate. Doing it here means no
    // timer is needed — the packaged exe's event loop stays quiet.
    if (buckets.size >= MAX_TRACKED_IPS) {
      for (const [key, val] of buckets) {
        if (now - val.last >= BURST * REFILL_MS) buckets.delete(key);
      }
    }
    buckets.set(ip, { tokens: BURST - 1, last: now });
    return false;
  }

  const refilled = Math.min(BURST, seen.tokens + (now - seen.last) / REFILL_MS);
  if (refilled < 1) {
    seen.tokens = refilled; // keep the partial credit; don't reset the clock
    seen.last = now;
    return true;
  }
  seen.tokens = refilled - 1;
  seen.last = now;
  return false;
}

// POST /api/leads  - PUBLIC. An enquiry from the website's contact form or
// chatbot. Returns a bare acknowledgement: the visitor has no use for the row,
// and echoing it back would leak the id sequence.
router.post('/', async (req, res) => {
  if (throttled(req.ip)) {
    res.setHeader('Retry-After', String(Math.ceil(REFILL_MS / 1000)));
    return res.status(429).json({
      error: "That's a few enquiries already — please WhatsApp us instead.",
    });
  }

  const { lead, error, trapped } = cleanLeadInput(req.body);
  if (error) return res.status(400).json({ error });

  // Honeypot hit: answer exactly as if it worked and drop the row, so a bot
  // gets no signal to adapt to.
  if (trapped) return res.status(201).json({ ok: true });

  try {
    // Double-tap suppression. The same number from the same source inside ten
    // minutes is a double-click or a retry-after-timeout, not a second
    // enquiry. Same 201 either way — the visitor did nothing wrong.
    const dupe = await query(
      `SELECT 1 FROM lead
        WHERE phone = $1 AND source = $2 AND created_at > now() - interval '10 minutes'
        LIMIT 1`,
      [lead.phone, lead.source]
    );
    if (dupe.rowCount) return res.status(201).json({ ok: true });

    await query(
      `INSERT INTO lead (name, phone, phone_e164, email, interest, source, message)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [lead.name, lead.phone, lead.phone_e164, lead.email,
       lead.interest, lead.source, lead.message]
    );
    res.status(201).json({ ok: true });
  } catch (err) {
    // cleanLeadInput already caps every field and whitelists `source`, so the
    // table's CHECK shouldn't fire — but if lib and migration ever drift, that
    // is the caller's data being wrong, not our server. 23514 = check
    // violation, 22001 = value too long.
    if (err.code === '23514' || err.code === '22001') {
      return res.status(400).json({ error: 'That enquiry could not be saved — please check the details.' });
    }
    console.error(err); // never log req.body: it's PII and attacker-controlled
    res.status(500).json({ error: 'Could not send that. Please try again.' });
  }
});

// The console filters and paginates client-side over a bare array, like every
// other list endpoint here. But this is the one table an anonymous caller can
// grow, so "return everything" would be a self-inflicted DoS if the form were
// ever flooded — hence a default cap, with ?limit= (clamped) for a full dump.
// Same clamp-don't-trust idiom as expiryWindowDays in lib/members.js.
function listLimit(value) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n) || n <= 0) return 500;
  return Math.min(n, 2000);
}

// GET /api/leads  - staff only. Newest first; the console shows every column.
router.get('/', requireAuth, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT id, name, phone, phone_e164, email, interest, source, message, created_at
         FROM lead
        ORDER BY created_at DESC, id DESC
        LIMIT $1`,
      [listLimit(req.query.limit)]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load enquiries.' });
  }
});

// DELETE /api/leads/:id  - staff only. Used once an enquiry has been dealt with.
router.delete('/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Bad enquiry id.' });
  }

  try {
    const { rowCount } = await query('DELETE FROM lead WHERE id = $1', [id]);
    if (!rowCount) return res.status(404).json({ error: 'Enquiry not found.' });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not delete that enquiry.' });
  }
});

export default router;
