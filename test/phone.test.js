import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePhone } from '../lib/phone.js';

// normalizePhone feeds the staff console's WhatsApp "Reply" link, so the
// property that matters most is the NEGATIVE one: junk must return null rather
// than a plausible-looking wrong number.

test('normalizePhone: bare Indian mobiles get the country code', () => {
  assert.equal(normalizePhone('9876543210'), '919876543210');
  assert.equal(normalizePhone('6364908005'), '916364908005');
  // 10 digits that happen to begin 91 are a real mobile, not a country code.
  assert.equal(normalizePhone('9188765432'), '919188765432');
});

test('normalizePhone: separators and surrounding whitespace are noise', () => {
  for (const input of ['98765 43210', '98765-43210', '(98765) 43210', '  98765 43210  ', '98765.43210']) {
    assert.equal(normalizePhone(input), '919876543210', input);
  }
});

test('normalizePhone: trunk 0, + and 00 prefixes all resolve', () => {
  assert.equal(normalizePhone('09876543210'), '919876543210');
  assert.equal(normalizePhone('+91 98765 43210'), '919876543210');
  assert.equal(normalizePhone('+919876543210'), '919876543210');
  assert.equal(normalizePhone('0091 98765 43210'), '919876543210');
  assert.equal(normalizePhone('0919876543210'), '919876543210');
  assert.equal(normalizePhone('+91 0 98765 43210'), '919876543210');
});

test('normalizePhone: already-normalised input is unchanged (idempotent for India)', () => {
  const once = normalizePhone('98765 43210');
  assert.equal(once, '919876543210');
  assert.equal(normalizePhone(once), once);
});

test('normalizePhone: an explicit + accepts other countries on length alone', () => {
  assert.equal(normalizePhone('+971 50 123 4567'), '971501234567');
  assert.equal(normalizePhone('+1 415 555 2671'), '14155552671');
  assert.equal(normalizePhone('004915123456789'), '4915123456789');
});

// The bug this module exists to prevent. Stripping non-digits out of prose
// invents a number: 'flat 302, call 9876543210' becomes 3029876543210, which
// is a real dialable string belonging to somebody else entirely.
test('normalizePhone: prose and multiple numbers are rejected, never salvaged', () => {
  for (const input of [
    'flat 302, call 9876543210',
    'call me on 9876543210',
    '9876543210 / 9123456789',
    '9876543210, 9123456789',
    '9876543210x',
    '+91 9876543210 (whatsapp)',
    "i'll call you",
    'available after 6',
  ]) {
    assert.equal(normalizePhone(input), null, input);
  }
});

test('normalizePhone: wrong length or non-mobile series is rejected', () => {
  assert.equal(normalizePhone('987654321'), null);    // 9 digits
  assert.equal(normalizePhone('98765432101'), null);  // 11, no cc, not 91-prefixed
  assert.equal(normalizePhone('1234567890'), null);   // 10 but starts 1
  assert.equal(normalizePhone('5876543210'), null);   // 10 but starts 5 (landline)
  assert.equal(normalizePhone('911234567890'), null); // 91 + non-mobile
  assert.equal(normalizePhone('9'.repeat(40)), null); // absurd length
});

test('normalizePhone: without a + we do not guess a foreign country code', () => {
  // 12 digits that aren't 91-prefixed could be anything; guessing would dial
  // a stranger. Staff still see the raw value in the console and can call it.
  assert.equal(normalizePhone('971501234567'), null);
});

test('normalizePhone: non-string input never throws', () => {
  assert.equal(normalizePhone(9876543210), '919876543210'); // finite number is fine
  for (const input of [null, undefined, {}, [], true, NaN, Infinity, '', '   ', '+']) {
    assert.equal(normalizePhone(input), null, String(input));
  }
});

// A stored value must never be re-normalised: it round-trips for Indian
// numbers but NOT for foreign ones, so any future backfill has to read the raw
// `phone` column, never `phone_e164`.
test('normalizePhone: re-running a stored foreign number nulls it (documented trap)', () => {
  const stored = normalizePhone('+971 50 123 4567');
  assert.equal(stored, '971501234567');
  assert.equal(normalizePhone(stored), null);
});
