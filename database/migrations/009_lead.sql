-- 009: website enquiries ("leads").
-- The public site's contact form and chatbot used to file enquiries into the
-- visitor's own browser storage, which meant an enquiry sent from someone's
-- phone was invisible to staff forever. They now POST here instead.
--
-- phone is stored EXACTLY as the visitor typed it (the chatbot accepts free
-- text, so it may not even be a number). phone_e164 is the digits-only
-- dialable form used to build the staff console's WhatsApp click-to-chat link,
-- and is NULL when the input couldn't be parsed — see lib/leads.js
-- normalizePhone, which never guesses.
--
-- Run manually after review (like the other migrations):
--   psql "$DATABASE_URL" -f database/migrations/009_lead.sql

BEGIN;

CREATE TABLE lead (
    id         SERIAL PRIMARY KEY,
    name       TEXT NOT NULL,
    phone      TEXT NOT NULL,          -- raw, as typed by the visitor
    phone_e164 TEXT,                   -- dialable digits, NULL when unparseable
    email      TEXT,
    interest   TEXT,                   -- which program / "Pricing" / etc.
    source     TEXT NOT NULL
                 CHECK (source IN ('Website form','Chatbot')),
    message    TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The console lists newest-first and nothing else; one index covers it.
CREATE INDEX idx_lead_created_at ON lead (created_at DESC);

COMMIT;
