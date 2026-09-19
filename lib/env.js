// Environment loading that works both in dev and inside a packaged executable.
//
// In dev, `.env` sits in the backend folder and is found via the process CWD —
// dotenv's default. Inside a pkg-built binary there IS no repo: staff double-
// click the exe from anywhere (Explorer, a shortcut, a different drive), so the
// CWD is unreliable. The convention becomes: the `.env` lives NEXT TO the
// executable, and we resolve it from process.execPath instead.
//
// Import this module FIRST (before anything that reads process.env at module
// load, like db.js building its Pool) — ESM guarantees it evaluates once,
// ahead of its importers.
import path from 'path';
import dotenv from 'dotenv';

// Pure resolver so the rule is unit-testable without touching the real env:
//   packaged  -> <directory of the executable>/.env
//   otherwise -> <cwd>/.env  (dotenv's default behaviour, made explicit)
export function resolveEnvPath({ isPackaged, execPath, cwd } = {}) {
  if (isPackaged) return path.join(path.dirname(String(execPath || '')), '.env');
  return path.join(String(cwd || ''), '.env');
}

dotenv.config({
  path: resolveEnvPath({
    // `process.pkg` is defined only inside a pkg-built binary.
    isPackaged: Boolean(process.pkg),
    execPath: process.execPath,
    cwd: process.cwd(),
  }),
});
