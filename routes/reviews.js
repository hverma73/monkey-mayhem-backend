import express from 'express';
import { fetchPlace, readConfig } from '../lib/googlePlaces.js';
import { makeThrottle } from '../lib/rateLimit.js';

const router = express.Router();

// GET /api/reviews — PUBLIC. The club's live Google rating and reviews for the
// marketing site. Read-only, so no body parser and no ordering constraint
// against the global express.json; it only has to mount above the /api 404.
//
// This route deliberately holds no database and no disk. Google Maps Platform
// Terms 3.2.3(a)(iii) forbid copying and saving user reviews, so review text
// exists only for the lifetime of the response that carries it. See
// lib/googlePlaces.js for the full rule set.

// A read-only public endpoint has a different abuse shape from the enquiry POST
// — the risk is quota burn, not spam — so it gets its own, looser bucket rather
// than sharing the leads one. Same token-bucket idiom, same lazy sweep, so
// still no timer in the packaged exe's event loop.
const BURST = 30;
const REFILL_MS = 2 * 1000; // one more read every two seconds
const MAX_TRACKED_IPS = 5000;
const throttled = makeThrottle({ burst: BURST, refillMs: REFILL_MS, maxTrackedIps: MAX_TRACKED_IPS });

// Single-flight: while one upstream call is in the air, every other request
// waits on the SAME promise instead of starting its own. This is not caching —
// nothing outlives the request that paid for it — it just stops a burst of
// visitors turning into a burst of billable Place Details calls.
let inFlight = null;

// Opt-in memo, off unless GOOGLE_PLACES_CACHE_SECONDS is set. Holding Google
// Maps Content past its request is caching under Terms 3.2.3(b); the knob
// exists because Place Details bills per call with 1,000 free a month, and that
// trade-off belongs to the club. Default 0 keeps us inside the terms.
let memo = null; // { at, payload }

router.get('/', async (req, res, next) => {
  const cfg = readConfig();

  // Not configured is a normal state, not an error: the site falls back to its
  // own curated quotes. 200 with configured:false keeps that off the error path.
  if (!cfg.configured) {
    return res.json({
      configured: false,
      reason:
        'Set GOOGLE_MAPS_API_KEY and GOOGLE_PLACE_ID to show live Google reviews.',
      rating: null,
      total: null,
      reviews: [],
      photos: [],
    });
  }

  if (throttled(req.ip)) {
    res.setHeader('Retry-After', '2');
    return res.status(429).json({ error: 'Too many requests — try again shortly.' });
  }

  try {
    if (cfg.cacheSeconds > 0 && memo && Date.now() - memo.at < cfg.cacheSeconds * 1000) {
      return res.json(memo.payload);
    }

    if (!inFlight) {
      inFlight = fetchPlace({ config: cfg }).finally(() => {
        inFlight = null;
      });
    }
    const place = await inFlight;

    const payload = { configured: true, ...place };
    if (cfg.cacheSeconds > 0) memo = { at: Date.now(), payload };

    // Never let a shared cache hold Google content: the terms are about our
    // storage, and a CDN copy is still our storage.
    res.setHeader('Cache-Control', 'no-store');
    return res.json(payload);
  } catch (err) {
    if (err.code === 'NOT_CONFIGURED') {
      return res.json({ configured: false, rating: null, total: null, reviews: [], photos: [] });
    }
    // Google being down must not take the marketing site down with it — the
    // page falls back to its curated quotes on any non-2xx.
    console.error('[reviews] Places API failed:', err.message);
    return res.status(502).json({
      error: 'Could not reach Google right now.',
      configured: true,
      rating: null,
      total: null,
      reviews: [],
      photos: [],
    });
  }
});

export default router;
