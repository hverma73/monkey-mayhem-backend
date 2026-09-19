import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { resolveEnvPath } from '../lib/env.js';

test('resolveEnvPath: packaged mode resolves .env beside the executable', () => {
  // Windows-style exe path (the shipped target) — path.join normalises for the
  // host platform, so compare against a join built the same way.
  const p = resolveEnvPath({
    isPackaged: true,
    execPath: path.join('C:', 'gym', 'monkey-mayhem.exe'),
    cwd: path.join('C:', 'Windows', 'System32'), // CWD must be IGNORED
  });
  assert.equal(p, path.join('C:', 'gym', '.env'));

  // POSIX binary too (the throwaway test build).
  const q = resolveEnvPath({ isPackaged: true, execPath: '/opt/mm/monkey-mayhem', cwd: '/tmp' });
  assert.equal(q, path.join('/opt/mm', '.env'));
});

test('resolveEnvPath: dev mode resolves .env in the CWD (dotenv default)', () => {
  const p = resolveEnvPath({ isPackaged: false, execPath: '/usr/local/bin/node', cwd: '/repo/backend' });
  assert.equal(p, path.join('/repo/backend', '.env'));
});

test('resolveEnvPath: missing fields degrade to a usable relative path, never throw', () => {
  assert.equal(resolveEnvPath({}), path.join('', '.env'));
  assert.equal(resolveEnvPath(), path.join('', '.env'));
  assert.equal(resolveEnvPath({ isPackaged: true }), path.join('.', '.env'));
});
