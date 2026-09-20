// env first: the Pool below reads process.env at module load, and lib/env.js
// resolves the .env location correctly in dev AND inside a packaged executable.
import './lib/env.js';
import pg from 'pg';
import { readDbConfig } from './lib/dbConfig.js';

const { Pool } = pg;

// A single shared pool for the whole app.
export const pool = new Pool({
  ...readDbConfig(),
});

pool.on('error', (err) => {
  console.error('Unexpected PostgreSQL pool error:', err);
});

// Small helper so routes can write `query(sql, params)`.
export const query = (text, params) => pool.query(text, params);
