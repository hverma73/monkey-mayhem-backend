// Google Places API (New) client — the ONLY sanctioned way to put the club's
// real Google reviews and photos on the public site.
//
// Why a whole module instead of scraping maps.google.com: Google Maps Platform
// Terms 3.2.3(a) ("No Scraping") forbid "(i) pre-fetch, index, store, reshare,
// or rehost Google Maps Content outside the services" and "(iii) copy and save
// business names, addresses, or user reviews". maps.google.com also serves a
// JavaScript shell to any non-browser client, so there is no review text in the
// HTML to take even if the terms allowed it.
//
// THE RULES THIS FILE EXISTS TO ENFORCE — read before changing anything here:
//
//  * Review text, author names and ratings are NEVER written to the database,
//    to disk, or to a long-lived cache. Terms 3.2.3(b) ("No Caching") allow
//    caching only what the Maps Service Specific Terms permit, and for the
//    Places API that is exactly one thing: latitude/longitude, for up to 30
//    consecutive days. The place ID is the only field storable indefinitely —
//    which is why GOOGLE_PLACE_ID lives in .env and nothing else does.
//  * Photo bytes are never proxied or re-hosted. We ask Google for a
//    short-lived photoUri and hand that to the browser, which loads the image
//    straight from Google's CDN. A photo `name` is explicitly documented as
//    non-cacheable and expiring, so mirroring it would break as well as breach.
//  * Attribution is not optional. Every review must carry its author's name,
//    avatar and profile link, and the page must link back to the listing on
//    Google Maps. buildAttribution() below assembles what the UI needs.
//
// Pure functions (everything except fetchPlace) live here rather than in the
// route so they are testable — see test/googlePlaces.test.js, and the rule in
// lib/members.js.

const PLACES_BASE = 'https://places.googleapis.com/v1';

// Sub-selecting nested paths does not reduce the billing SKU, but it does keep
// the response small and documents exactly what we use.
const FIELD_MASK = [
  'id',
  'displayName',
  'googleMapsUri',
  'rating',
  'userRatingCount',
  'reviews.name',
  'reviews.text',
  'reviews.originalText',
  'reviews.rating',
  'reviews.relativePublishTimeDescription',
  'reviews.publishTime',
  'reviews.googleMapsUri',
  'reviews.authorAttribution',
  'photos.name',
  'photos.widthPx',
  'photos.heightPx',
  'photos.authorAttributions',
].join(',');

// Google returns at most 5 reviews and at most 10 photos, always. There is no
// page token, no sort parameter and no way to raise either ceiling on this API
// (places.get accepts only languageCode, regionCode and sessionToken). Anything
// needing the full review corpus needs the Business Profile API instead, which
// is a different product requiring the owner's authorisation.
export const MAX_REVIEWS = 5;
export const MAX_PHOTOS = 10;

export function readConfig(env = process.env) {
  const key = (env.GOOGLE_MAPS_API_KEY || '').trim();
  const placeId = (env.GOOGLE_PLACE_ID || '').trim();
  const photoCount = clampInt(env.GOOGLE_PLACES_PHOTOS, 0, MAX_PHOTOS, 0);
  return {
    key,
    placeId,
    configured: Boolean(key && placeId),
    // Photos cost a SEPARATE $7/1000 call EACH (one media lookup per photo), so
    // they stay off unless the club opts in by setting a count.
    photoCount,
    photoWidthPx: clampInt(env.GOOGLE_PLACES_PHOTO_WIDTH, 200, 4800, 1200),
    languageCode: (env.GOOGLE_PLACES_LANGUAGE || 'en').trim(),
    // 0 = no caching, which is what the terms require. Any other value stores
    // Google Maps Content in memory past the request that fetched it: that is
    // caching under 3.2.3(b) and it is the club's call to make, not ours. It is
    // here because Place Details billing is per request with only 1,000 free
    // calls a month, so an uncached public page can run up a real bill.
    cacheSeconds: clampInt(env.GOOGLE_PLACES_CACHE_SECONDS, 0, 86400, 0),
  };
}

function clampInt(raw, min, max, fallback) {
  const n = Number.parseInt(String(raw ?? '').trim(), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// Shape one Review resource into what the site renders. Note `text` is a
// LocalizedText ({ text, languageCode }) — the review string is nested one
// level deeper than it looks. originalText is the untranslated original; when
// it differs from text, Google has translated for us and we must say so.
export function normalizeReview(review) {
  if (!review || typeof review !== 'object') return null;
  const shown = review.text?.text?.trim() || '';
  const original = review.originalText?.text?.trim() || '';
  if (!shown && !original) return null; // a rating with no words has nothing to quote

  const author = review.authorAttribution || {};
  return {
    id: review.name || null,
    text: shown || original,
    // True when Google handed us a translation rather than what was written.
    translated: Boolean(shown && original && shown !== original),
    originalText: original && original !== shown ? original : null,
    originalLanguage: review.originalText?.languageCode || null,
    rating: typeof review.rating === 'number' ? review.rating : null,
    relativeTime: review.relativePublishTimeDescription || null,
    publishTime: review.publishTime || null,
    // Attribution — all three are required alongside the quote.
    authorName: author.displayName || null,
    authorUri: author.uri || null,
    authorPhotoUri: author.photoUri || null,
    // Where a reader goes to see this review in its original context.
    sourceUri: review.googleMapsUri || null,
  };
}

export function normalizePlace(json) {
  const place = json && typeof json === 'object' ? json : {};
  const reviews = Array.isArray(place.reviews)
    ? place.reviews.map(normalizeReview).filter(Boolean).slice(0, MAX_REVIEWS)
    : [];
  return {
    placeId: place.id || null,
    name: place.displayName?.text || null,
    mapsUri: place.googleMapsUri || null,
    rating: typeof place.rating === 'number' ? place.rating : null,
    total: typeof place.userRatingCount === 'number' ? place.userRatingCount : null,
    reviews,
    photos: [], // filled in by fetchPlace only when photos are switched on
  };
}

// What the UI must display for the panel as a whole. Google requires the reader
// to be told how the set was chosen — these five are not "our best five", they
// are whichever five Google judged most relevant.
export function buildAttribution(place) {
  return {
    provider: 'Google',
    mapsUri: place.mapsUri || null,
    ordering:
      `Google returns up to ${MAX_REVIEWS} reviews, ordered by relevance rather ` +
      'than by date, and we show them unedited.',
  };
}

async function requestJson(url, key, { fetchImpl, headers = {} }) {
  const res = await fetchImpl(url, {
    method: 'GET',
    headers: { 'X-Goog-Api-Key': key, ...headers },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    // Google's error body is { error: { code, message, status } }.
    const message = body?.error?.message || `Places API request failed (${res.status})`;
    const err = new Error(message);
    err.status = res.status;
    err.googleStatus = body?.error?.status || null;
    throw err;
  }
  return body;
}

// Resolve one photo resource to a short-lived image URL on Google's CDN.
//
// skipHttpRedirect=true makes Google return { photoUri, name } as JSON instead
// of 302-ing to the bytes. That matters twice over: the browser can load the
// image without ever seeing our API key, and we never touch the bytes, so we
// are not re-hosting. The URI is short-lived by design — it is passed straight
// through to the response and never stored.
async function resolvePhoto(photo, cfg, { fetchImpl }) {
  const name = photo?.name;
  if (!name) return null;
  const url =
    `${PLACES_BASE}/${name}/media` +
    `?maxWidthPx=${cfg.photoWidthPx}&skipHttpRedirect=true`;
  try {
    const body = await requestJson(url, cfg.key, { fetchImpl });
    if (!body?.photoUri) return null;
    return {
      url: body.photoUri,
      widthPx: photo.widthPx || null,
      heightPx: photo.heightPx || null,
      // Photo attributions are HTML anchors from Google; the UI renders them
      // as text and links, never as raw HTML.
      attributions: (photo.authorAttributions || []).map((a) => ({
        name: a.displayName || null,
        uri: a.uri || null,
        photoUri: a.photoUri || null,
      })),
    };
  } catch {
    // One bad photo must not take down the whole reviews panel.
    return null;
  }
}

// Fetch the place live. `fetchImpl` is injectable so tests never touch Google.
export async function fetchPlace({ config, fetchImpl = globalThis.fetch } = {}) {
  const cfg = config || readConfig();
  if (!cfg.configured) {
    const err = new Error('Google Places is not configured.');
    err.code = 'NOT_CONFIGURED';
    throw err;
  }

  const url =
    `${PLACES_BASE}/places/${encodeURIComponent(cfg.placeId)}` +
    `?languageCode=${encodeURIComponent(cfg.languageCode)}`;
  const json = await requestJson(url, cfg.key, {
    fetchImpl,
    headers: { 'X-Goog-FieldMask': FIELD_MASK },
  });

  const place = normalizePlace(json);

  if (cfg.photoCount > 0 && Array.isArray(json.photos)) {
    const wanted = json.photos.slice(0, cfg.photoCount);
    const resolved = await Promise.all(
      wanted.map((p) => resolvePhoto(p, cfg, { fetchImpl }))
    );
    place.photos = resolved.filter(Boolean);
  }

  return { ...place, attribution: buildAttribution(place) };
}

export const __testables = { FIELD_MASK, clampInt, PLACES_BASE };
