import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readDbConfig } from '../lib/dbConfig.js';

test('readDbConfig maps PostgreSQL env vars and leaves SSL off by default', () => {
  assert.deepEqual(readDbConfig({
    PGHOST: 'localhost',
    PGPORT: '5433',
    PGDATABASE: 'gym',
    PGUSER: 'postgres',
    PGPASSWORD: 'secret',
  }), {
    host: 'localhost',
    port: 5433,
    database: 'gym',
    user: 'postgres',
    password: 'secret',
  });
});

test('readDbConfig enables verified TLS when PGSSL is enabled', () => {
  assert.deepEqual(readDbConfig({ PGSSL: '1' }).ssl, { rejectUnauthorized: true });
  assert.deepEqual(readDbConfig({ PGSSL: 'true' }).ssl, { rejectUnauthorized: true });
  assert.equal(readDbConfig({ PGSSL: '0' }).ssl, undefined);
});