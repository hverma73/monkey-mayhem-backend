import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loginHandler } from '../routes/auth.js';

function response() {
  return {
    statusCode: 200,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
  };
}

test('login throttles the sixth attempt from one IP before database access', async () => {
  const req = { ip: 'auth-test-ip', body: {} };
  const responses = [];
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const res = response();
    await loginHandler(req, res);
    responses.push(res);
  }

  assert.equal(responses[5].statusCode, 429);
  assert.deepEqual(responses[5].payload, {
    error: 'Too many attempts — try again in a minute.',
  });
});