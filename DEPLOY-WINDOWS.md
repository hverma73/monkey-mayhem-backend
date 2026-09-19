# Running Monkey Mayhem on a Windows machine (single .exe)

The app ships as **one executable** — `monkey-mayhem.exe` — that serves both the
API and the web UI at **http://localhost:9000** and opens your browser
automatically. The only thing it needs on the machine is **PostgreSQL** (the
database cannot live inside an .exe). Data is local to each machine.

## Build it (developer machine, once per release)

```bash
cd monkey-mayhem-backend
npm run build:exe        # -> release/monkey-mayhem.exe + release/.env.example
```

Ship two files to the target machine: `monkey-mayhem.exe` and a filled-in
`.env` (start from `.env.example`).

## One-time setup on the target machine

1. **Install PostgreSQL** (postgresql.org → Windows installer). Remember the
   password you set for the `postgres` user during install.
2. **Create the database and tables** — open pgAdmin → Query Tool:
   - `CREATE DATABASE postgresdb;`
   - Open a Query Tool **on postgresdb** and run the whole of
     `database/schema.sql`.
3. **Create a login** for the app (Query Tool on postgresdb), e.g. the
   `tejadmin` insert supplied separately, or ask the developer for one. The
   password is stored as a bcrypt hash — never plaintext.
4. **Make the `.env`**: copy `.env.example` to a file named exactly `.env`
   **in the same folder as `monkey-mayhem.exe`**, then edit:
   - `PGPASSWORD=` → the postgres password from step 1
   - `JWT_SECRET=` → any long random string (a password generator is fine)

## Run

Double-click `monkey-mayhem.exe`. A console window stays open (that's the
server — closing it stops the app) and the browser opens at
http://localhost:9000. Log in with the account from step 3.

## Updating to a new version

Replace `monkey-mayhem.exe` with the new build. Keep the existing `.env`.
The database and all member/payment data are untouched.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `password authentication failed for user ...` (code 28P01) | The `PGUSER`/`PGPASSWORD` in `.env` don't match this machine's Postgres. Use `postgres` + the installer password. |
| `database "postgresdb" does not exist` | Step 2 was skipped — create the DB and run `schema.sql`. |
| `FATAL: JWT_SECRET is not set` | The `.env` isn't next to the exe, or the line is missing. |
| Port already in use | Something else owns 9000 — set `PORT=9001` in `.env` (the browser will open on the new port). |
| Invoice PDFs / UI look fine offline? | Yes — fonts and the logo are baked into the exe. The web UI's Google-Fonts link needs internet only for the fancy headline font; it falls back to system fonts offline. |

## Notes

- The exe listens on this machine only (localhost). Staff on other computers
  can't reach it unless you deliberately expose it.
- Back up the data occasionally: `pg_dump -U postgres postgresdb > backup.sql`
  (pgAdmin has a Backup option too).
- `MM_NO_OPEN=1` in `.env` disables the auto-opening browser (e.g. when
  running as a background service).
