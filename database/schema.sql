-- =====================================================================
--  MONKEY MAYHEM FIGHT CLUB - Membership Management
--  PostgreSQL schema (run this in pgAdmin Query Tool against a fresh DB)
-- ---------------------------------------------------------------------
--  How to use in pgAdmin:
--    1. Create a database, e.g.  monkey_mayhem
--    2. Open it -> Query Tool
--    3. Paste this whole file and Run (F5)
-- =====================================================================

-- Clean slate (safe to re-run during development) -----------------------
DROP VIEW  IF EXISTS membership_billing   CASCADE;
DROP VIEW  IF EXISTS member_overview      CASCADE;
DROP TABLE IF EXISTS lead                 CASCADE;
DROP TABLE IF EXISTS membership_pause     CASCADE;
DROP TABLE IF EXISTS payment              CASCADE;
DROP TABLE IF EXISTS office_use           CASCADE;
DROP TABLE IF EXISTS guardian             CASCADE;
DROP TABLE IF EXISTS emergency_contact    CASCADE;
DROP TABLE IF EXISTS membership           CASCADE;
DROP TABLE IF EXISTS member               CASCADE;
DROP TABLE IF EXISTS package              CASCADE;
DROP TABLE IF EXISTS app_user             CASCADE;
DROP SEQUENCE IF EXISTS billing_doc_seq   CASCADE;

-- ---------------------------------------------------------------------
-- 1. Login accounts
-- ---------------------------------------------------------------------
CREATE TABLE app_user (
    id            SERIAL PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,          -- bcrypt hash, never store plaintext
    full_name     TEXT NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE package (
    package_id      SERIAL PRIMARY KEY,
    name            TEXT NOT NULL UNIQUE,
    -- Exactly one duration unit: month-based standard plans, day-based custom
    -- plans (migration 008). End dates prefer days when present.
    duration_months INT  CHECK (duration_months > 0),
    duration_days   INT  CHECK (duration_days > 0),
    CONSTRAINT package_one_duration_check CHECK (num_nonnulls(duration_months, duration_days) = 1),
    price           NUMERIC(10,2) NOT NULL CHECK (price >= 0),
    gender          TEXT NOT NULL DEFAULT 'All'
                      CHECK (gender IN ('Male','Female','Other','All')),
    is_active       BOOLEAN NOT NULL DEFAULT true
);

INSERT INTO package (name, duration_months, price, gender) VALUES
    ('1 Month',  1,  3500.00, 'All'),
    ('3 Months', 3,  9000.00, 'All'),
    ('6 Months', 6, 18000.00, 'All'),
    ('1 Year',  12, 25000.00, 'All');

CREATE TABLE member (
    member_id     SERIAL PRIMARY KEY,
    full_name     TEXT NOT NULL,
    date_of_birth DATE,
    gender        TEXT CHECK (gender IN ('Male','Female','Other')),
    address       TEXT,
    mobile_no1    TEXT NOT NULL,
    mobile_no2    TEXT,
    email         TEXT,
    occupation    TEXT,
    blood_group   TEXT,           -- e.g. 'O+', 'AB-'
    height_cm     NUMERIC(5,1),   -- centimetres
    weight_kg     NUMERIC(5,1),   -- kilograms
    id_proof_no   TEXT,           -- Aadhaar / PAN / DL number, etc.
    photo_url     TEXT,           -- optional member photo
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_member_full_name ON member (lower(full_name));

-- ---------------------------------------------------------------------
-- 4. Membership - one row per subscription period.
--    This is what drives "active/inactive" and "expiring in 7 days".
--    A member can have many over time (renewals); the latest end_date wins.
-- ---------------------------------------------------------------------
-- Shared running number for invoice_no + re_no (interleaves like 60/61).
CREATE SEQUENCE billing_doc_seq START 1;

CREATE TABLE membership (
    id               SERIAL PRIMARY KEY,
    member_id        INT NOT NULL REFERENCES member(member_id) ON DELETE CASCADE,
    package_id       INT NOT NULL REFERENCES package(package_id),
    start_date       DATE NOT NULL DEFAULT CURRENT_DATE,
    end_date         DATE NOT NULL,
    amount_paid      NUMERIC(10,2),                    -- legacy; payments table is now authoritative
    invoice_no       INT DEFAULT nextval('billing_doc_seq'),
    amount           NUMERIC(10,2),                    -- gross plan charge (invoice "Amount")
    registration_fee NUMERIC(10,2) NOT NULL DEFAULT 0,
    discount         NUMERIC(10,2) NOT NULL DEFAULT 0,
    notes            TEXT,                             -- invoice "Comment"
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT membership_money_check
      CHECK ((amount IS NULL OR amount >= 0) AND registration_fee >= 0 AND discount >= 0)
);

CREATE INDEX idx_membership_member  ON membership (member_id);
CREATE INDEX idx_membership_enddate ON membership (end_date);

-- ---------------------------------------------------------------------
-- 4b. Payment receipts (1 membership/invoice : many payments)
-- ---------------------------------------------------------------------
CREATE TABLE payment (
    payment_id    SERIAL PRIMARY KEY,
    re_no         INT NOT NULL DEFAULT nextval('billing_doc_seq'),
    membership_id INT NOT NULL REFERENCES membership(id) ON DELETE CASCADE,
    member_id     INT NOT NULL REFERENCES member(member_id) ON DELETE CASCADE,
    paid_amount   NUMERIC(10,2) NOT NULL CHECK (paid_amount >= 0),
    pay_mode      TEXT NOT NULL DEFAULT 'Cash'
                    CHECK (pay_mode IN ('Cash','Card','UPI','Bank Transfer','Cheque','Other')),
    details       TEXT,
    executive     TEXT,                                -- staff name who took the payment
    paid_on       DATE NOT NULL DEFAULT CURRENT_DATE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_payment_member     ON payment (member_id);
CREATE INDEX idx_payment_membership ON payment (membership_id);
CREATE INDEX idx_payment_paid_on    ON payment (paid_on);

-- ---------------------------------------------------------------------
-- 4c. Membership pause / freeze (1 membership : many pauses)
--     Open-ended: a row with resume_date IS NULL means "currently paused".
--     On resume, resume_date is set and `days` (the frozen days added back to
--     the membership's end_date) is recorded.
-- ---------------------------------------------------------------------
CREATE TABLE membership_pause (
    pause_id      SERIAL PRIMARY KEY,
    membership_id INT  NOT NULL REFERENCES membership(id)    ON DELETE CASCADE,
    member_id     INT  NOT NULL REFERENCES member(member_id) ON DELETE CASCADE,
    pause_start   DATE NOT NULL DEFAULT CURRENT_DATE,   -- when the freeze began
    resume_date   DATE,                                 -- NULL = still paused; set on resume
    days          INT  CHECK (days IS NULL OR days >= 0), -- frozen days added back (set on resume)
    planned_days  INT  CHECK (planned_days IS NULL OR planned_days > 0), -- optional intended length
    reason        TEXT,
    created_by    TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_pause_membership ON membership_pause (membership_id);
CREATE INDEX idx_pause_member     ON membership_pause (member_id);
-- At most one open (unresumed) pause per membership.
CREATE UNIQUE INDEX idx_one_open_pause ON membership_pause (membership_id) WHERE resume_date IS NULL;
-- At most one open pause per MEMBER (stacking can give a member several periods;
-- a frozen period's end_date drifts, so guard at the member level too).
CREATE UNIQUE INDEX idx_one_open_pause_member ON membership_pause (member_id) WHERE resume_date IS NULL;

-- ---------------------------------------------------------------------
-- 5. Emergency contact (1 member : many contacts)
-- ---------------------------------------------------------------------
CREATE TABLE emergency_contact (
    id           SERIAL PRIMARY KEY,
    member_id    INT NOT NULL REFERENCES member(member_id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    relationship TEXT,
    phone        TEXT,
    address      TEXT
);
CREATE INDEX idx_emergency_member ON emergency_contact (member_id);

-- ---------------------------------------------------------------------
-- 6. Guardian details (1 member : many guardians)
-- ---------------------------------------------------------------------
CREATE TABLE guardian (
    id            SERIAL PRIMARY KEY,
    member_id     INT NOT NULL REFERENCES member(member_id) ON DELETE CASCADE,
    name          TEXT NOT NULL,
    relationship  TEXT,
    mobile_number TEXT
);
CREATE INDEX idx_guardian_member ON guardian (member_id);

-- ---------------------------------------------------------------------
-- 7. Office use - administrative metadata (1 member : 1 row)
-- ---------------------------------------------------------------------
CREATE TABLE office_use (
    member_id        INT PRIMARY KEY REFERENCES member(member_id) ON DELETE CASCADE,
    membership_no    TEXT,            -- the gym's membership card number
    batch            TEXT,            -- e.g. 'Morning', 'Evening'
    trainer          TEXT,
    date_of_joining  DATE,
    id_verified      BOOLEAN NOT NULL DEFAULT false,
    medical_reviewed BOOLEAN NOT NULL DEFAULT false,
    staff_name       TEXT,
    staff_signature  TEXT             -- typed name / signature reference
);

-- ---------------------------------------------------------------------
-- 7b. Lead - a website enquiry (contact form or chatbot). Not tied to a
--     member: these are strangers who haven't joined yet.
--     phone is stored exactly as typed (the chatbot takes free text, so it may
--     not be a number at all); phone_e164 is the dialable form used for the
--     console's WhatsApp reply link, NULL when unparseable.
--     (See migration 009_lead.sql — keep these two definitions identical.)
-- ---------------------------------------------------------------------
CREATE TABLE lead (
    id         SERIAL PRIMARY KEY,
    name       TEXT NOT NULL,
    phone      TEXT NOT NULL,          -- raw, as typed by the visitor
    phone_e164 TEXT,                   -- dialable digits, NULL when unparseable
    email      TEXT,
    interest   TEXT,                   -- which program / 'Pricing' / etc.
    source     TEXT NOT NULL
                 CHECK (source IN ('Website form','Chatbot')),
    message    TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The console lists newest-first and nothing else; one index covers it.
CREATE INDEX idx_lead_created_at ON lead (created_at DESC);

-- ---------------------------------------------------------------------
-- 8. member_overview - the convenience view the app reads from.
--    One row per member describing them TODAY: the LATERAL picks an open-paused
--    period first (its end_date is frozen and may sit in the past), else the
--    period covering today, else the soonest upcoming, else the most-recent
--    past. Computes age, days_to_expiry and the 5-value status. upcoming_count
--    and next_start_date support the renew form + roster "queued" hints.
--    (See migration 006_stacked_periods.sql — keep these two bodies identical.)
-- ---------------------------------------------------------------------
CREATE VIEW member_overview AS
SELECT
    m.member_id,
    m.full_name,
    m.date_of_birth,
    CASE WHEN m.date_of_birth IS NULL THEN NULL
         ELSE date_part('year', age(m.date_of_birth))::int END   AS age,
    m.gender,
    m.email,
    m.mobile_no1,
    m.blood_group,
    m.photo_url,
    ou.membership_no,
    ou.batch,
    ou.trainer,
    ou.date_of_joining,
    ms.start_date,
    ms.end_date,
    p.package_id,
    p.name            AS package_name,
    p.duration_months,
    ms.amount_paid,                                              -- legacy
    (ms.end_date - CURRENT_DATE)                                 AS days_to_expiry,
    CASE
        WHEN ms.end_date IS NULL              THEN 'No Plan'
        WHEN EXISTS (SELECT 1 FROM membership_pause mp
                     WHERE mp.membership_id = ms.id AND mp.resume_date IS NULL) THEN 'Paused'
        WHEN ms.start_date > CURRENT_DATE     THEN 'Upcoming'
        WHEN ms.end_date  >= CURRENT_DATE     THEN 'Active'
        ELSE 'Inactive'
    END                                                          AS status,
    -- New billing columns appended at the end (keeps CREATE OR REPLACE VIEW in
    -- migration 002 happy — it can only add columns, not reorder existing ones).
    ms.invoice_no,
    ms.amount,
    ms.registration_fee,
    ms.discount,
    (COALESCE(ms.amount,0) + ms.registration_fee - ms.discount)    AS total_amount,
    COALESCE(pay.paid_amount, 0)                                   AS paid_amount,
    (COALESCE(ms.amount,0) + ms.registration_fee - ms.discount)
        - COALESCE(pay.paid_amount, 0)                             AS balance,
    -- Appended (migration 006): queued-period count and where a new stacked
    -- period would land (furthest not-yet-expired end_date, else today).
    (SELECT count(*) FROM membership u
      WHERE u.member_id = m.member_id AND u.start_date > CURRENT_DATE)::int AS upcoming_count,
    COALESCE(
      (SELECT MAX(u.end_date) FROM membership u
        WHERE u.member_id = m.member_id AND u.end_date >= CURRENT_DATE),
      CURRENT_DATE
    )                                                              AS next_start_date
FROM member m
LEFT JOIN LATERAL (
    SELECT x.*
    FROM membership x
    WHERE x.member_id = m.member_id
    ORDER BY
      (EXISTS (SELECT 1 FROM membership_pause mp
               WHERE mp.membership_id = x.id AND mp.resume_date IS NULL)) DESC,  -- open pause wins
      (x.start_date <= CURRENT_DATE AND x.end_date >= CURRENT_DATE) DESC,        -- else covering today
      CASE WHEN x.start_date > CURRENT_DATE THEN x.start_date END ASC NULLS LAST,-- else soonest upcoming
      x.end_date DESC                                                           -- else most-recent past
    LIMIT 1
) ms ON true
LEFT JOIN package    p  ON p.package_id  = ms.package_id
LEFT JOIN office_use ou ON ou.member_id  = m.member_id
LEFT JOIN LATERAL (
    SELECT COALESCE(SUM(pm.paid_amount),0) AS paid_amount
    FROM payment pm WHERE pm.membership_id = ms.id
) pay ON true;

-- ---------------------------------------------------------------------
-- 8b. membership_billing - one row per membership/invoice with totals.
--     Powers the Payments tab and the invoice PDF.
-- ---------------------------------------------------------------------
CREATE VIEW membership_billing AS
SELECT
    ms.id                                                          AS membership_id,
    ms.invoice_no,
    ms.member_id,
    m.full_name,
    m.mobile_no1,
    m.email,
    m.address,
    m.id_proof_no,
    ms.package_id,
    p.name                                                         AS package_name,
    p.duration_months,
    ms.start_date,
    ms.end_date,
    ms.amount,
    ms.registration_fee,
    ms.discount,
    (COALESCE(ms.amount,0) + ms.registration_fee - ms.discount)    AS total_amount,
    COALESCE(pay.paid_amount, 0)                                   AS paid_amount,
    (COALESCE(ms.amount,0) + ms.registration_fee - ms.discount)
        - COALESCE(pay.paid_amount, 0)                             AS balance,
    ms.notes,
    ms.created_at,
    CASE
        WHEN EXISTS (SELECT 1 FROM membership_pause mp
                     WHERE mp.membership_id = ms.id AND mp.resume_date IS NULL) THEN 'Paused'
        WHEN ms.start_date > CURRENT_DATE THEN 'Upcoming'
        WHEN ms.end_date  >= CURRENT_DATE THEN 'Active'
        ELSE 'Inactive'
    END                                                            AS membership_status,
    -- Appended (migration 006): server-computed phase the frontend buckets on.
    CASE
        WHEN ms.start_date > CURRENT_DATE THEN 'upcoming'
        WHEN ms.end_date  <  CURRENT_DATE THEN 'past'
        ELSE 'current'
    END                                                            AS period_phase,
    -- Appended (migration 008): day-based plan length (NULL on month plans).
    p.duration_days
FROM membership ms
JOIN member  m ON m.member_id  = ms.member_id
JOIN package p ON p.package_id = ms.package_id
LEFT JOIN LATERAL (
    SELECT COALESCE(SUM(pm.paid_amount),0) AS paid_amount
    FROM payment pm WHERE pm.membership_id = ms.id
) pay ON true;

-- =====================================================================
--  Optional sample member so the dashboard isn't empty on first run.
--  (The admin login is created by the backend seed script,
--   not here, because the password must be bcrypt-hashed in code.)
-- =====================================================================
WITH new_member AS (
    INSERT INTO member (full_name, date_of_birth, gender, address, mobile_no1,
                        email, occupation, blood_group, height_cm, weight_kg, id_proof_no)
    VALUES ('Bruno Castellanos', '1996-04-22', 'Male', 'Vidyanagar, Hubballi',
            '9876543210', 'bruno@example.com', 'Welder', 'O+', 178, 82, 'XXXX-1234')
    RETURNING member_id
), new_membership AS (
    INSERT INTO membership (member_id, package_id, start_date, end_date, amount_paid, amount)
    SELECT member_id, 2, CURRENT_DATE - 87, CURRENT_DATE + 3, 9000, 9000
    FROM new_member     -- expires in 3 days -> shows up in "On the ropes"
    RETURNING id, member_id
)
INSERT INTO payment (membership_id, member_id, paid_amount, pay_mode, executive, paid_on)
SELECT id, member_id, 9000, 'Cash', 'Gym Admin', CURRENT_DATE - 87
FROM new_membership;
