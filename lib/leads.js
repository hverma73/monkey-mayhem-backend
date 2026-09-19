// Pure lead helpers — no DB, no I/O — so they can be unit-tested with
// `node --test` (same split as lib/members.js). The route owns the SQL and the
// rate limiter's Map; this file owns the decisions.
//
// Phone parsing lives in lib/phone.js: member numbers are the same free-text
// problem, so it isn't lead-specific.

import { normalizePhone } from './phone.js';

// ---------------------------------------------------------------------
// Input validation for the PUBLIC POST /api/leads
// ---------------------------------------------------------------------
// This is the only endpoint an anonymous visitor can write through, so the
// payload is treated as hostile: unknown keys are dropped (never spread into
// the insert), every field is trimmed and hard-capped, and `source` must be
// one of ours. Caps are generous for a human and tiny for a script.
const LIMITS = {
  name: 120,
  phone: 32,
  email: 160,
  interest: 80,
  message: 2000,
};

// Must match the CHECK constraint in migration 009.
const SOURCES = ['Website form', 'Chatbot'];

function str(value, max) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, max);
}

// Returns { lead } on success or { error } with a message safe to show a
// visitor. Callers insert `lead`'s fields verbatim.
export function cleanLeadInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'Send your name and phone number.' };
  }

  const name = str(body.name, LIMITS.name);
  const phone = str(body.phone, LIMITS.phone);
  if (!name || !phone) {
    return { error: 'Send your name and phone number.' };
  }

  const source = SOURCES.includes(body.source) ? body.source : SOURCES[0];

  return {
    lead: {
      name,
      phone,
      // Best effort only. A null here must NEVER reject the enquiry: "i'll
      // call you" plus a name still tells staff to go read the chat, and
      // rejecting it would throw away exactly the leads they most need.
      phone_e164: normalizePhone(phone),
      email: str(body.email, LIMITS.email) || null,
      interest: str(body.interest, LIMITS.interest) || null,
      source,
      message: str(body.message, LIMITS.message) || null,
    },
    // Honeypot: a field the real form renders hidden and leaves empty.
    // Anything in it means something filled in every input it could see.
    trapped: Boolean(str(body.trap, 200)),
  };
}
