// env first: the Pool below reads process.env at module load, and lib/env.js
// resolves the .env location correctly in dev AND inside a packaged executable.
import './lib/env.js';
import pg from 'pg';

const { Pool } = pg;

// A single shared pool for the whole app.
export const pool = new Pool({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT) || 5432,
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
});

pool.on('error', (err) => {
  console.error('Unexpected PostgreSQL pool error:', err);
});

// Small helper so routes can write `query(sql, params)`.
export const query = (text, params) => pool.query(text, params);
