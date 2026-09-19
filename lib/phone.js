// Pure phone helpers — no DB, no I/O — so they can be unit-tested with
// `node --test` (same split as lib/members.js).
//
// This is the ONLY place a phone number is turned into a dialable string.
// It lives in its own module rather than in lib/leads.js because member
// numbers (member.mobile_no1) are the same free-text problem, and the obvious
// next feature is a WhatsApp button for chasing renewals.
//
// WhatsApp click-to-chat wants digits only, country code first, no '+' and no
// separators:  https://wa.me/919876543210  — so that's the output shape.

// Noise between digits: spaces, hyphen, dot, parens, and the unicode dashes
// people paste out of Word.
//
// NOTE what is deliberately absent: letters, '/', and ','. Those appear when
// someone writes prose ("flat 302, call 9876543210") or two numbers in one
// field, and stripping them fabricates a number that was never there — the
// example above yields 3029876543210, which is somebody else entirely. Junk
// must return null, because a Reply button that opens the wrong person's chat
// is far worse than one that's disabled.
const SEPARATORS = /[\s\-().‐-―]/g;

// Indian mobile series: 10 digits starting 6-9. Landlines (2-5) can't be
// reached on WhatsApp and carry no recoverable STD code, so they're rejected.
const INDIAN_MOBILE = /^[6-9][0-9]{9}$/;

const DEFAULT_CC = '91'; // India — the club is in Mangaluru

export function normalizePhone(input, defaultCc = DEFAULT_CC) {
  // Strings, plus plain numbers (a scripted caller may send 9876543210
  // unquoted). Anything else is junk, not something to String() into
  // '[object Object]'.
  const raw =
    typeof input === 'string' ? input
    : typeof input === 'number' && Number.isFinite(input) ? String(input)
    : null;
  if (raw === null) return null;

  let s = raw.trim();
  if (!s || s.length > 32) return null; // absurd length: not a phone number

  // A leading '+' is the ONLY signal that the caller supplied a country code,
  // and it changes every rule below — so capture it before cleaning.
  const hadPlus = s.startsWith('+');
  if (hadPlus) s = s.slice(1).trim();

  const digits = s.replace(SEPARATORS, '');
  if (!/^[0-9]+$/.test(digits)) return null; // letters, '/', ',', a second '+'

  let d = digits;
  let international = hadPlus;
  // '00' is the older international access prefix — same meaning as '+'.
  if (!international && d.startsWith('00')) {
    d = d.slice(2);
    international = true;
  }

  // A national (country-code-less) Indian number, with an optional trunk '0'.
  const indian = (n) => {
    const bare = n.startsWith('0') ? n.slice(1) : n;
    return INDIAN_MOBILE.test(bare) ? defaultCc + bare : null;
  };

  if (international) {
    if (d.startsWith('0')) return null; // no country code starts with 0
    // Our own country code: validate the rest rather than waving through
    // '+91 123 456 7890'. No country code starts 910-919, so this is
    // unambiguous.
    if (d.startsWith(defaultCc)) return indian(d.slice(defaultCc.length));
    // Another country's code — we don't know their numbering rules, so the
    // only check is E.164's own length bounds.
    return d.length >= 8 && d.length <= 15 ? d : null;
  }

  // No country code given. Peel a trunk '0', then an unprefixed '91', then
  // require a bare Indian mobile. Without a '+' we will NOT guess that a
  // 12-digit string is some foreign number.
  if (d.startsWith('0')) d = d.slice(1);
  if (d.length === defaultCc.length + 10 && d.startsWith(defaultCc)) {
    d = d.slice(defaultCc.length);
  }
  return INDIAN_MOBILE.test(d) ? defaultCc + d : null;
}
