import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeThrottle } from '../lib/rateLimit.js';

test('makeThrottle allows a burst then blocks the next call', () => {
  const throttle = makeThrottle({ burst: 3, refillMs: 1000 });
  assert.equal(throttle('ip'), false);
  assert.equal(throttle('ip'), false);
  assert.equal(throttle('ip'), false);
  assert.equal(throttle('ip'), true);
});

test('makeThrottle refills one token after refillMs', () => {
  let now = 0;
  const throttle = makeThrottle({ burst: 1, refillMs: 100, now: () => now });
  assert.equal(throttle('ip'), false);
  assert.equal(throttle('ip'), true);
  now = 100;
  assert.equal(throttle('ip'), false);
});

test('makeThrottle keeps keys independent', () => {
  const throttle = makeThrottle({ burst: 1, refillMs: 1000 });
  assert.equal(throttle('first'), false);
  assert.equal(throttle('first'), true);
  assert.equal(throttle('second'), false);
});

test('makeThrottle sweeps idle entries when the map reaches its limit', () => {
  let now = 0;
  const throttle = makeThrottle({ burst: 1, refillMs: 100, maxTrackedIps: 2, now: () => now });
  throttle('first');
  throttle('second');
  now = 100;
  throttle('third');
  assert.equal(throttle('first'), false);
});