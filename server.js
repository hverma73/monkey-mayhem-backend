// MUST be the first import: loads .env (from beside the executable when
// packaged, else the CWD) before any module reads process.env at load time.
import './lib/env.js';

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import express from 'express';
import cors from 'cors';

import authRoutes from './routes/auth.js';
import leadRoutes from './routes/leads.js';
import memberRoutes from './routes/members.js';
import importRoutes from './routes/upload.js';
import paymentRoutes from './routes/payments.js';
import reportRoutes from './routes/reports.js';
import reviewRoutes from './routes/reviews.js';
import { requireAuth } from './middleware/auth.js';
import { requestLogger, errorLogger } from './middleware/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Guard the JWT secret at startup. The secret always comes from the
// environment — never from code.
//  - Missing entirely: fail fast in every environment. jwt.sign/verify throw
//    on an empty secret, so every login would 500 with no clear cause.
//  - Still the shipped placeholder: tokens are forgeable by anyone who has
//    read the repo — refuse to start in production, warn loudly in dev.
const JWT_PLACEHOLDER = 'change-this-to-a-long-random-secret';
if (!process.env.JWT_SECRET) {
  console.error(
    'FATAL: JWT_SECRET is not set. Set a long random value in the environment / .env, e.g.\n' +
    '  JWT_SECRET=$(openssl rand -hex 32)'
  );
  process.exit(1);
}
if (process.env.JWT_SECRET === JWT_PLACEHOLDER) {
  if (process.env.NODE_ENV === 'production') {
    console.error('FATAL: JWT_SECRET is still the placeholder value — refusing to start in production.');
    process.exit(1);
  }
  console.warn('WARNING: JWT_SECRET is still the placeholder value. Fine for local dev, but set a real secret before deploying.');
}

const app = express();

app.use(cors({
  origin: process.env.CLIENT_ORIGIN || 'http://localhost:5173',
  exposedHeaders: ['Content-Disposition'], // so the browser can read download filenames
}));
// Logging sits above the body parsers so the public /api/leads mount below —
// which needs its own tighter parser, and therefore answers before the global
// one runs — still gets logged like every other request.
app.use(requestLogger);

// Website enquiries. POST is PUBLIC (an anonymous visitor files it), so this
// mounts without requireAuth and the router guards GET/DELETE itself — the
// same arrangement /api/auth uses for /me. Its own 8kb JSON cap goes here,
// ahead of the 5mb global parser: an enquiry is a handful of short fields, so a
// junk megabyte should be refused at parse time rather than parsed and then
// discarded by the field caps in lib/leads.js.
app.use('/api/leads', express.json({ limit: '8kb' }), leadRoutes);

app.use(express.json({ limit: '5mb' })); // JSON imports can be largish

// The club's live Google rating and reviews, for the public site. PUBLIC and
// read-only: no token, and no body parser to order against the global one — it
// only has to sit above the /api 404 below. It stores nothing; see
// lib/googlePlaces.js for why Google's terms forbid caching review text.
app.use('/api/reviews', reviewRoutes);

app.get('/api/health', (_req, res) => res.json({ ok: true }));

// Public auth endpoints (login). /me checks auth itself.
app.use('/api/auth', authRoutes);

// Everything below requires a valid token.
app.use('/api/members', requireAuth, memberRoutes);
app.use('/api/import', requireAuth, importRoutes);
app.use('/api/payments', requireAuth, paymentRoutes);
app.use('/api/reports', requireAuth, reportRoutes);

// Unknown API routes answer JSON like everything else under /api — and never
// fall through to the SPA fallback below (which would return index.html).
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found.' }));

// ---- packaged/self-hosted frontend -----------------------------------------
// The build pipeline copies the React build to <server dir>/client, so the one
// executable serves both the API and the UI. In dev that folder doesn't exist
// and this whole block is inert (the Vite dev server + proxy handle the UI).
const CLIENT_DIR = path.join(__dirname, 'client');
if (fs.existsSync(path.join(CLIENT_DIR, 'index.html'))) {
  app.use(express.static(CLIENT_DIR));
  // SPA fallback: the frontend uses BrowserRouter, so a refresh/deep link on
  // /members/5 or /payments must serve index.html and let React route it.
  // API paths are excluded so unknown /api/* still return JSON 404s.
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.join(CLIENT_DIR, 'index.html'));
  });
}

app.use(errorLogger);

// Final error handler: answer { error } JSON like every route does. Without
// this, body-parser errors (oversized upload, malformed JSON) fall through to
// Express's default handler, which sends an HTML stack trace — server file
// paths included — and the frontend can only show a bare status code.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err.status || err.statusCode || 500;
  // "Too large" means different things on different routes: a 10 MB spreadsheet
  // on /api/import, an 8 KB enquiry on the public /api/leads. Don't tell a
  // website visitor their message was too big a *file*.
  const tooLarge = req.path.startsWith('/api/import')
    ? 'That file is too large to upload (limit 10 MB).'
    : 'That was too long to send — please shorten it.';
  const error =
    err.type === 'entity.too.large' ? tooLarge
    : status < 500 ? 'Bad request.'
    : 'Something went wrong.';
  res.status(status).json({ error });
});

const PORT = process.env.PORT || 9000;
app.listen(PORT, () => {
  console.log(`Monkey Mayhem API running on http://localhost:${PORT}`);
  // Double-click-and-go: inside the packaged executable, pop the app open in
  // the default browser. Never in dev (annoying), and a failure is harmless —
  // staff can still browse to the URL by hand. MM_NO_OPEN=1 disables it for
  // headless/service runs.
  if (process.pkg && !process.env.MM_NO_OPEN) {
    const url = `http://localhost:${PORT}`;
    const opener =
      process.platform === 'win32' ? `start "" "${url}"`
      : process.platform === 'darwin' ? `open "${url}"`
      : `xdg-open "${url}"`;
    exec(opener, { shell: process.platform === 'win32' ? 'cmd.exe' : undefined }, () => {});
  }
});
