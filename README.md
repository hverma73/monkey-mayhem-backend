# Monkey Mayhem Fight Club — Membership Management

A full-stack member management app for a gym/fight club: admin login, member
CRUD with filters, a 7-day expiry watchlist, an expiry calendar, gender-tagged
custom packages, **payments & invoicing** (part-payments, invoice PDFs, Excel
reports), **membership pause/freeze**, and JSON bulk import.
Stack: **React (Vite) + Node/Express + PostgreSQL**.

```
files/
├── monkey-mayhem-backend/        # Express API (this folder)
│   ├── database/
│   │   ├── schema.sql            # run this in pgAdmin first (fresh DB)
│   │   └── migrations/           # incremental upgrades for an existing DB
│   ├── routes/                   # auth, members, payments, reports, upload
│   ├── lib/billing.js            # pure billing/pause math (unit-tested)
│   ├── services/invoicePdf.js    # PDFKit invoice generator
│   ├── config/business.js        # gym details printed on invoices
│   ├── middleware/               # auth (JWT) + request/error logging
│   ├── assets/fonts/             # TTFs so the invoice PDF can print ₹
│   └── test/billing.test.js      # node --test unit tests
└── monkey-mayhem-frontend/       # React app (Vite)
```

---

## 1. Database (pgAdmin)

1. In pgAdmin, create a database named `monkey_mayhem`.
2. Open it → **Query Tool** → paste the contents of `database/schema.sql` → **Run (F5)**.

`schema.sql` is the full, current schema for a **fresh** database. It creates:

- `app_user` — login accounts (bcrypt password hashes).
- `package` — the price tiers, now with a `gender` dimension (`Male`/`Female`/`Other`/`All`) and an `is_active` flag. Seeded with the four default tiers.
- `member`, `emergency_contact`, `guardian`, `office_use` — member and related detail.
- `membership` — one row per subscription period; doubles as the **invoice header** (`amount`, `registration_fee`, `discount`, `invoice_no`, `notes`).
- `payment` — payment receipts (one membership → many receipts; `re_no`, `pay_mode`, `executive`, `paid_on`).
- `membership_pause` — pause/freeze windows (one membership → many pauses).
- `billing_doc_seq` — a shared sequence so invoice numbers and receipt numbers interleave.
- Two views: `member_overview` (drives the roster/dashboard — computes age, days-to-expiry, and `Active`/`Inactive`/`Paused`/`No Plan` status) and `membership_billing` (one row per invoice with total/paid/balance — powers the Payments tab and the PDF).

It also inserts one sample member (with a paid receipt) so the dashboard isn't empty.

> **Note on Age:** age is *not* stored — it changes every year and would go
> stale. We store `date_of_birth` and compute age live in `member_overview`.

### Already have data? Use the migrations instead

If you have an existing database with members in it, **do not** re-run `schema.sql`
(it drops everything). Apply the incremental migrations **once each, in this
order** (each is wrapped in a transaction). Do not re-run an older migration
after a newer one has been applied — later migrations reshape the views and
drop columns the older files reference:

```bash
psql "$DATABASE_URL" -f database/migrations/001_package_gender.sql      # gender on packages
psql "$DATABASE_URL" -f database/migrations/002_payments.sql            # payments + invoicing
psql "$DATABASE_URL" -f database/migrations/003_membership_pause.sql    # pause/freeze
psql "$DATABASE_URL" -f database/migrations/004_pause_resume.sql        # open-ended pause/resume
psql "$DATABASE_URL" -f database/migrations/005_pause_planned_days.sql  # planned pause length
psql "$DATABASE_URL" -f database/migrations/005_remove_role.sql         # drop app_user.role (run after the other 005)
psql "$DATABASE_URL" -f database/migrations/006_stacked_periods.sql     # stacked renewal periods
psql "$DATABASE_URL" -f database/migrations/007_constraints.sql         # data-integrity CHECKs (see file header)
psql "$DATABASE_URL" -f database/migrations/008_package_duration_days.sql # day-based custom packages
psql "$DATABASE_URL" -f database/migrations/009_lead.sql                # website enquiries (leads)
```

> Note: two files share the `005` prefix (a numbering slip that predates this
> list); run them in the order shown above.
>
> Database migrations should be reviewed by a human before being run against a
> live database — read each file's header comment first.

---

## 2. Backend

```bash
cd monkey-mayhem-backend
cp .env.example .env        # then edit .env with your Postgres password + a JWT secret
npm install
npm run seed                # creates the first admin login (default: admin / monkey123)
npm run dev                 # API on http://localhost:9000 (uses node --watch)
```

The seed command reads `SEED_ADMIN_*` from `.env`. Change the default password
after first login with `reset-password.js`.

**Port:** the API listens on `PORT` (defaults to **9000** if unset). The frontend
dev proxy targets `9000`, so keep `PORT=9000` in development.

### Resetting a forgotten password

Passwords are bcrypt hashes and can't be decrypted — you set a *new* one:

```bash
RESET_USERNAME=admin RESET_PASSWORD='new-strong-pass' node reset-password.js
# or: node reset-password.js <username> <newPassword>
```

(Env vars are preferred — a CLI arg is visible in shell history and the process list.)

### Tests

The billing/pause math in `lib/billing.js` is pure and unit-tested:

```bash
node --test test/billing.test.js     # or: node --test
```

---

## 3. Frontend

```bash
cd monkey-mayhem-frontend
npm install
npm run dev                 # app on http://localhost:5173
```

The Vite dev server proxies `/api` to the backend on port 9000, so no CORS setup
is needed in development. Open http://localhost:5173 and log in with the seeded admin.

---

## Features

- **Login** — JWT auth; passwords stored as bcrypt hashes. `reset-password.js` recovers a locked-out account.
- **Create / edit members** — one form covering personal info, emergency contacts (repeatable), guardians (repeatable), office-use fields, and a starting package. Saved across all tables in a single transaction.
- **Roster** — all members with live name search and an Active / Inactive / No-plan filter. Status also surfaces **Paused** memberships.
- **On the Ropes** — a table above the roster listing everyone whose membership ends in the next 7 days, with a renew shortcut.
- **Expiry calendar** — month grid marking which members expire on each day.
- **Custom Package Plan** — create new packages on the fly, optionally tagged to a gender (`Male`/`Female`/`Other`/`All`, where `All` = unisex). The member form's package picker can be filtered by the member's gender.
- **Renewals** — add new membership periods from a member's page; end dates are computed automatically from the package length. The amount paid is also recorded as a payment receipt.
- **Payments & invoicing** — each membership period is an invoice (`amount + registration fee − discount`). Record, edit, and delete payment receipts; take part-payments and track the outstanding balance; six pay modes (Cash/Card/UPI/Bank Transfer/Cheque/Other). The **Custom Plan** action creates a membership and an optional first payment in one transaction.
- **Invoice PDF** — download a per-membership invoice (PDFKit) with the To/From boxes, plan details, amounts, payment-transaction table, and terms. Prints ₹ when the bundled Unicode font is present (otherwise falls back to `Rs.`); drops in a logo from `assets/logo.png` if you add one.
- **Reports (Payments page tabs)** — *Invoices*, *Payment History* (per-member month grid for a calendar year), and *Member Report* (one row per member, incl. no-plan members). Each can be exported to **Excel (.xlsx)**.
- **Membership pause / freeze** — staff can freeze a plan (Cult.fit-style). Paused days are added back to the plan (`end_date` moves out) so paid time isn't lost. The pause-day budget depends on plan length (1mo→7, 3mo→15, 6mo→30, 1yr→60; other lengths ≈5 days/month). Overlapping pauses and pauses past the end date are rejected, and a live pause can be cancelled.
- **JSON import** — pick a `.json` file; it's parsed in the browser and posted to `/api/import`, which inserts each record in its own transaction. A paid amount on a record is recorded as a payment receipt.
- **Dashboard stats** — totals, active count, expiring-this-week, and revenue this month (summed from the payment ledger for the current calendar month).
- **Request logging** — every request is logged (method, path, status, duration, user); unhandled errors are logged with a stack trace.

### Packages (seeded)

| Package  | Duration  | Price   | Gender |
|----------|-----------|---------|--------|
| 1 Month  | 1 month   | ₹3,500  | All    |
| 3 Months | 3 months  | ₹9,000  | All    |
| 6 Months | 6 months  | ₹18,000 | All    |
| 1 Year   | 12 months | ₹25,000 | All    |

Edit prices/durations directly in the `package` table, add rows, or create them
from the **Custom Package Plan** screen. `All` plans are offered to everyone;
gender-specific plans only appear for that gender.

---

## JSON import format

An array of records. Only `member.full_name` and `member.mobile_no1` are
required; everything else is optional. `package_id` refers to a row in the
`package` table (1=1mo, 2=3mo, 3=6mo, 4=1yr by default). An optional
`membership.amount_paid` is logged as a payment receipt. See
`sample-members.json` for a working example.

```json
[
  {
    "member": { "full_name": "Priya D.", "mobile_no1": "9900112233", "blood_group": "B+" },
    "emergencyContacts": [{ "name": "Raghav", "relationship": "Father", "phone": "990011" }],
    "guardians": [{ "name": "Raghav", "mobile_number": "990011" }],
    "office": { "membership_no": "MM-1001", "batch": "Morning", "trainer": "Vikram" },
    "membership": { "package_id": 3, "start_date": "2026-05-01", "amount_paid": 18000 }
  }
]
```

---

## API reference

All routes are under `/api` and require a `Bearer` token, **except**
`POST /api/auth/login`, `GET /api/health`, and `POST /api/leads` — the last of
these is the website's enquiry form, which anonymous visitors must be able to
submit (see [Leads](#leads)). The logged-in user's name from the token is
recorded as the `executive` on payments.

### Auth

| Method | Path             | Purpose                          |
|--------|------------------|----------------------------------|
| POST   | `/auth/login`    | Log in, returns a token + user   |
| GET    | `/auth/me`       | Who am I (restore a session)     |

### Leads

Website enquiries from the public site's contact form and chatbot.

| Method | Path           | Purpose                                              |
|--------|----------------|------------------------------------------------------|
| POST   | `/leads`       | **Public** — file an enquiry. `{ok:true}`            |
| GET    | `/leads`       | List, newest first. `?limit=` (default 500, max 2000) |
| DELETE | `/leads/:id`   | Delete one enquiry                                   |

`POST` is the only unauthenticated write in the app, so it is defended in
layers: a per-IP token bucket (5 immediately, then one more every two minutes),
an 8 KB body cap applied ahead of the global JSON parser, per-field length caps
and a `source` whitelist, a honeypot field the real form hides, and
ten-minute suppression of the same number from the same source. None of that
stops a distributed flood — if real spam arrives, the answer is a captcha on the
form or a rate limit at the reverse proxy. Note also that the per-IP bucket
resets on restart, is per-process, and collapses to a single global bucket
behind a proxy, because no `trust proxy` is set (and setting it without a proxy
in front would make the limit spoofable via `X-Forwarded-For`).

Each row stores the phone twice: `phone` exactly as the visitor typed it, and
`phone_e164` — digits only, country code first, no `+` — which the staff
console uses to build a WhatsApp click-to-chat link. `phone_e164` is **null**
when the input wasn't a parseable number (the chatbot accepts free text), and
the console disables its Reply button for those rows rather than guess.
`lib/phone.js` owns that parsing and never salvages a number out of prose;
`npm test` covers it.

> A stored `phone_e164` must never be re-normalised — the round trip is safe
> for Indian numbers but nulls foreign ones. Any future backfill has to read
> the raw `phone` column.

### Members

| Method | Path                        | Purpose                                      |
|--------|-----------------------------|----------------------------------------------|
| GET    | `/members`                  | List + `?search=&status=` filters            |
| GET    | `/members/:id`              | Full member detail (incl. billing per period)|
| POST   | `/members`                  | Create member (all tables, one transaction)  |
| PUT    | `/members/:id`              | Update member                                |
| DELETE | `/members/:id`              | Delete member (cascades)                     |
| POST   | `/members/:id/renew`        | Add a membership period (+ payment receipt)  |
| GET    | `/members/expiring?days`    | Expiring in N days (default 7)               |
| GET    | `/members/calendar`         | `?year=&month=` expiries for a month         |
| GET    | `/members/stats`            | Dashboard counts + revenue this month        |
| GET    | `/members/packages`         | Price list (optional `?gender=`)             |
| POST   | `/members/packages`         | Create a custom package                      |
| GET    | `/members/:id/pause-info`   | Pause budget + history for the latest plan   |
| POST   | `/members/:id/pause`        | Pause/freeze the latest plan                 |
| DELETE | `/members/:id/pause/:pauseId` | Cancel a not-yet-ended pause               |

### Payments & invoices

| Method | Path                            | Purpose                                  |
|--------|---------------------------------|------------------------------------------|
| GET    | `/payments`                     | List receipts (`?status=&search=&membership_id=`) |
| POST   | `/payments`                     | Record a payment against a membership    |
| PUT    | `/payments/:id`                 | Edit a payment                           |
| DELETE | `/payments/:id`                 | Delete a payment                         |
| POST   | `/payments/custom-plan`         | Create a membership + optional 1st payment|
| GET    | `/payments/invoice/:membershipId` | Invoice **PDF** for one membership     |
| GET    | `/payments/export`              | Export the payments view to **.xlsx**    |

### Reports (all support `?search=`; history takes `?year=`)

| Method | Path                              | Purpose                                  |
|--------|-----------------------------------|------------------------------------------|
| GET    | `/reports/invoices`               | One row per invoice                      |
| GET    | `/reports/invoices/export`        | → **.xlsx**                              |
| GET    | `/reports/payment-history`        | Per-member month grid for a year         |
| GET    | `/reports/payment-history/export` | → **.xlsx** (register-style layout)      |
| GET    | `/reports/members`                | One row per member (incl. no-plan)       |
| GET    | `/reports/members/export`         | → **.xlsx**                              |

### Other

| Method | Path           | Purpose                          |
|--------|----------------|----------------------------------|
| POST   | `/import`      | Bulk import a JSON array         |
| GET    | `/health`      | Liveness check (public)          |

---

## Configuration (.env)

| Variable | Purpose |
|----------|---------|
| `PGHOST` `PGPORT` `PGDATABASE` `PGUSER` `PGPASSWORD` | PostgreSQL connection |
| `JWT_SECRET` | Token signing secret — use a long random string |
| `JWT_EXPIRES_IN` | Token lifetime (default `12h`) |
| `SEED_ADMIN_USERNAME` `SEED_ADMIN_PASSWORD` `SEED_ADMIN_NAME` | First admin (used by `npm run seed`) |
| `PORT` | API port (default `9000`) |
| `CLIENT_ORIGIN` | Allowed CORS origin (default `http://localhost:5173`) |
| `BIZ_NAME` `BIZ_ADDRESS` `BIZ_PHONE` `BIZ_EMAIL` `BIZ_GST` `BIZ_DISCIPLINE` `BIZ_TERMS` | *(optional)* Gym details printed on invoices; defaults live in `config/business.js`. Public info, not secrets. |
| `RESET_USERNAME` `RESET_PASSWORD` | *(optional)* Used only by `reset-password.js` |

On the frontend, `VITE_API_URL` is left blank in development (the Vite proxy
handles `/api`); set it to your deployed API origin in production.

---

## The logo

The app ships with a placeholder fist emblem. To use the real club logo:

1. **In the app UI:** save your logo as `monkey-mayhem-frontend/public/logo.png`, then in `src/components/Logo.jsx` replace the inline `<svg>` with:
   ```jsx
   <img src="/logo.png" alt="Monkey Mayhem Fight Club" width={size} height={size} />
   ```
2. **On invoice PDFs:** drop a `logo.png` into `monkey-mayhem-backend/assets/` and it's printed top-right automatically.

---

## Going to production (notes)

- Set a long random `JWT_SECRET` and a strong admin password.
- Put the API behind HTTPS and set `CLIENT_ORIGIN` to your real frontend origin.
- Set `BIZ_*` to your real business details so invoices read correctly.
- Apply pending `database/migrations/*` (human-reviewed) rather than `schema.sql`.
- `npm run build` in `monkey-mayhem-frontend/` produces a static `dist/` you can serve from any static host; point `VITE_API_URL` at your deployed API.
