import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAttribution,
  fetchPlace,
  MAX_REVIEWS,
  normalizePlace,
  normalizeReview,
  readConfig,
} from '../lib/googlePlaces.js';

// These tests exist because the shape of a Places review is easy to get subtly
// wrong: the review string is nested TWO levels deep (review.text.text, a
// LocalizedText), and a plain review.text read yields "[object Object]" on the
// live site. The parsing therefore gets pinned, and fetchPlace is exercised
// against a fake fetch so the suite never calls Google or needs a key.

test('normalizeReview: pulls the string out of LocalizedText, not the object', () => {
  const r = normalizeReview({
    name: 'places/X/reviews/Y',
    text: { text: 'Great coaches.', languageCode: 'en' },
    rating: 5,
    relativePublishTimeDescription: 'a month ago',
    authorAttribution: { displayName: 'A Member', uri: 'https://maps.google.com/u', photoUri: 'https://lh3/pic' },
    googleMapsUri: 'https://maps.google.com/review',
  });
  assert.equal(r.text, 'Great coaches.');
  assert.equal(r.rating, 5);
  assert.equal(r.authorName, 'A Member');
  assert.equal(r.authorUri, 'https://maps.google.com/u');
  assert.equal(r.authorPhotoUri, 'https://lh3/pic');
  assert.equal(r.sourceUri, 'https://maps.google.com/review');
  assert.equal(r.translated, false);
});

test('normalizeReview: a translated review keeps the original and says so', () => {
  const r = normalizeReview({
    text: { text: 'Very good gym.', languageCode: 'en' },
    originalText: { text: 'Tumba olleya gym.', languageCode: 'kn' },
  });
  assert.equal(r.translated, true);
  assert.equal(r.originalText, 'Tumba olleya gym.');
  assert.equal(r.originalLanguage, 'kn');
});

test('normalizeReview: a rating with no words has nothing to quote', () => {
  assert.equal(normalizeReview({ rating: 5 }), null);
  assert.equal(normalizeReview(null), null);
  assert.equal(normalizeReview({ text: { text: '   ' } }), null);
});

test('normalizePlace: survives a response missing every optional field', () => {
  const p = normalizePlace({});
  assert.deepEqual(p.reviews, []);
  assert.deepEqual(p.photos, []);
  assert.equal(p.rating, null);
  assert.equal(p.total, null);
  // A response that isn't an object at all must not throw either.
  assert.deepEqual(normalizePlace(null).reviews, []);
});

test('normalizePlace: never returns more than Google\'s five-review ceiling', () => {
  const many = Array.from({ length: 9 }, (_, i) => ({ text: { text: `review ${i}` } }));
  assert.equal(normalizePlace({ reviews: many }).reviews.length, MAX_REVIEWS);
});

test('readConfig: unconfigured unless BOTH the key and the place id are set', () => {
  assert.equal(readConfig({}).configured, false);
  assert.equal(readConfig({ GOOGLE_MAPS_API_KEY: 'k' }).configured, false);
  assert.equal(readConfig({ GOOGLE_PLACE_ID: 'p' }).configured, false);
  assert.equal(readConfig({ GOOGLE_MAPS_API_KEY: 'k', GOOGLE_PLACE_ID: 'p' }).configured, true);
  // Whitespace-only values are not configuration.
  assert.equal(readConfig({ GOOGLE_MAPS_API_KEY: '  ', GOOGLE_PLACE_ID: 'p' }).configured, false);
});

test('readConfig: caching is OFF by default — the terms allow no review cache', () => {
  assert.equal(readConfig({}).cacheSeconds, 0);
  assert.equal(readConfig({ GOOGLE_PLACES_CACHE_SECONDS: '600' }).cacheSeconds, 600);
  assert.equal(readConfig({ GOOGLE_PLACES_CACHE_SECONDS: 'nonsense' }).cacheSeconds, 0);
});

test('readConfig: photos are off by default and clamp to Google\'s ceiling', () => {
  assert.equal(readConfig({}).photoCount, 0);
  assert.equal(readConfig({ GOOGLE_PLACES_PHOTOS: '99' }).photoCount, 10);
  assert.equal(readConfig({ GOOGLE_PLACES_PHOTOS: '-4' }).photoCount, 0);
});

test('fetchPlace: sends the key and field mask as headers, never in the URL', async () => {
  const seen = [];
  const fetchImpl = async (url, opts) => {
    seen.push({ url, headers: opts.headers });
    return { ok: true, json: async () => ({ id: 'p', rating: 4.9, userRatingCount: 167, reviews: [] }) };
  };
  const config = { ...readConfig({ GOOGLE_MAPS_API_KEY: 'secret-key', GOOGLE_PLACE_ID: 'ChIJabc' }) };
  const place = await fetchPlace({ config, fetchImpl });

  assert.equal(seen.length, 1);
  assert.match(seen[0].url, /places\.googleapis\.com\/v1\/places\/ChIJabc/);
  assert.equal(seen[0].headers['X-Goog-Api-Key'], 'secret-key');
  assert.match(seen[0].headers['X-Goog-FieldMask'], /reviews\.authorAttribution/);
  // The key must not leak into the query string, which ends up in logs.
  assert.ok(!seen[0].url.includes('secret-key'));
  assert.equal(place.rating, 4.9);
  assert.equal(place.total, 167);
});

test('fetchPlace: photos stay unfetched until the club opts in', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return { ok: true, json: async () => ({ id: 'p', photos: [{ name: 'places/p/photos/a' }] }) };
  };
  const config = readConfig({ GOOGLE_MAPS_API_KEY: 'k', GOOGLE_PLACE_ID: 'p' });
  const place = await fetchPlace({ config, fetchImpl });
  assert.equal(calls, 1, 'no extra billable media call when photos are off');
  assert.deepEqual(place.photos, []);
});

test('fetchPlace: opted-in photos resolve to a short-lived Google URL, not our own', async () => {
  const fetchImpl = async (url) => {
    if (url.includes('/media')) {
      assert.match(url, /skipHttpRedirect=true/);
      return { ok: true, json: async () => ({ photoUri: 'https://lh3.googleusercontent.com/x' }) };
    }
    return {
      ok: true,
      json: async () => ({
        id: 'p',
        photos: [{ name: 'places/p/photos/a', widthPx: 1600, heightPx: 1200, authorAttributions: [{ displayName: 'Someone' }] }],
      }),
    };
  };
  const config = readConfig({ GOOGLE_MAPS_API_KEY: 'k', GOOGLE_PLACE_ID: 'p', GOOGLE_PLACES_PHOTOS: '1' });
  const place = await fetchPlace({ config, fetchImpl });
  assert.equal(place.photos.length, 1);
  assert.equal(place.photos[0].url, 'https://lh3.googleusercontent.com/x');
  assert.equal(place.photos[0].attributions[0].name, 'Someone');
});

test('fetchPlace: one broken photo does not sink the whole panel', async () => {
  const fetchImpl = async (url) => {
    if (url.includes('/media')) return { ok: false, status: 404, json: async () => ({ error: { message: 'gone' } }) };
    return { ok: true, json: async () => ({ id: 'p', reviews: [{ text: { text: 'Good.' } }], photos: [{ name: 'places/p/photos/a' }] }) };
  };
  const config = readConfig({ GOOGLE_MAPS_API_KEY: 'k', GOOGLE_PLACE_ID: 'p', GOOGLE_PLACES_PHOTOS: '2' });
  const place = await fetchPlace({ config, fetchImpl });
  assert.deepEqual(place.photos, []);
  assert.equal(place.reviews.length, 1, 'reviews still render');
});

test('fetchPlace: a Google error surfaces its message, not a bare status', async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 403,
    json: async () => ({ error: { code: 403, message: 'This API key is not authorized.', status: 'PERMISSION_DENIED' } }),
  });
  const config = readConfig({ GOOGLE_MAPS_API_KEY: 'k', GOOGLE_PLACE_ID: 'p' });
  await assert.rejects(() => fetchPlace({ config, fetchImpl }), /not authorized/);
});

test('fetchPlace: refuses to call Google when unconfigured', async () => {
  await assert.rejects(
    () => fetchPlace({ config: readConfig({}), fetchImpl: async () => { throw new Error('must not be called'); } }),
    (e) => e.code === 'NOT_CONFIGURED'
  );
});

test('buildAttribution: tells the reader how the five were chosen', () => {
  const a = buildAttribution({ mapsUri: 'https://maps.google.com/place' });
  assert.equal(a.provider, 'Google');
  assert.equal(a.mapsUri, 'https://maps.google.com/place');
  assert.match(a.ordering, /relevance/);
});
