// Build the app into a single self-contained executable.
//
//   npm run build:exe                    -> release/monkey-mayhem.exe (Windows x64)
//   npm run build:exe -- --targets node22-macos-arm64 --output build/mm-test
//                                        -> local test binary (not shipped)
//
// Pipeline:
//   1. Build the React frontend (vite build) so dist/ is fresh.
//   2. esbuild-bundle the ESM server into ONE CommonJS file (pkg can't ingest
//      ESM). pdfkit/exceljs stay external so their __dirname-relative data
//      reads keep working; pkg traces the leftover require()s into
//      node_modules. pg-native is an optional native dep we don't use.
//   3. Copy the frontend build to build/client (server.js serves it from
//      <bundle dir>/client).
//   4. pkg the bundle + assets (fonts, logo, client, pdfkit .afm metrics —
//      globs in package.json "pkg") into the target executable.
//   5. Emit release/.env.example for the target machine (never a real .env).
import { spawnSync } from 'child_process';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import esbuild from 'esbuild';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const FRONTEND = path.join(ROOT, '..', 'monkey-mayhem-frontend');

// CLI overrides for the throwaway local-test build.
const args = process.argv.slice(2);
const argOf = (flag, dflt) => {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : dflt;
};
const TARGETS = argOf('--targets', 'node22-win-x64');
const OUTPUT = argOf('--output', path.join('release', 'monkey-mayhem.exe'));

function run(label, cmd, cmdArgs, opts = {}) {
  console.log(`\n▸ ${label}`);
  const res = spawnSync(cmd, cmdArgs, { stdio: 'inherit', cwd: ROOT, ...opts });
  if (res.status !== 0) {
    console.error(`✗ ${label} failed (exit ${res.status})`);
    process.exit(res.status ?? 1);
  }
}

// 1. Fresh frontend build. One quoted command string: paths may contain spaces
//    or parens, and shell:true lets npm resolve on Windows (npm.cmd) too.
run('vite build (frontend)', `npm --prefix "${FRONTEND}" run build`, [], { shell: true });

// 2. Bundle the server to CJS — EVERYTHING except pg-native (an optional
//    native addon we don't use; pg only touches it behind a guarded getter).
//    Bundling pdfkit/exceljs too matters inside pkg: external requires hit
//    pkg's snapshot resolver, which fumbles conditional-export subpaths
//    (@noble/hashes), and esbuild's external dynamic import() stays a native
//    import that pkg's VM cannot perform. import.meta.url doesn't exist in
//    CJS, so shim it to the bundle's own file URL — invoicePdf's __dirname
//    math and server.js's CLIENT_DIR then resolve relative to build/.
console.log('\n▸ esbuild bundle (server.js -> build/server.cjs)');
await esbuild.build({
  entryPoints: [path.join(ROOT, 'server.js')],
  outfile: path.join(ROOT, 'build', 'server.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['pg-native'],
  banner: { js: `const __import_meta_url = require('url').pathToFileURL(__filename).href;` },
  define: { 'import.meta.url': '__import_meta_url' },
  logLevel: 'info',
});

// 3. Runtime data next to the bundle:
//    - frontend build -> build/client (served as the UI by the executable)
//    - pdfkit's base-14 font metrics -> build/data (bundled pdfkit reads
//      `__dirname + '/data/<font>.afm'`, and __dirname is build/)
console.log('\n▸ copy frontend dist -> build/client, pdfkit metrics -> build/data');
const CLIENT_OUT = path.join(ROOT, 'build', 'client');
fs.rmSync(CLIENT_OUT, { recursive: true, force: true });
fs.cpSync(path.join(FRONTEND, 'dist'), CLIENT_OUT, { recursive: true });
const DATA_OUT = path.join(ROOT, 'build', 'data');
fs.rmSync(DATA_OUT, { recursive: true, force: true });
fs.cpSync(path.join(ROOT, 'node_modules', 'pdfkit', 'js', 'data'), DATA_OUT, { recursive: true });

// 4. pkg the bundle. --config picks up the asset globs from package.json.
//
// GOTCHA: pkg expands asset globs with tinyglobby, and glob metacharacters in
// the PROJECT PATH itself — like the "(3)" in "files (3)" — make every pattern
// match nothing, silently shipping an exe with no fonts/logo/client. When the
// project path contains such characters, stage through a temp symlink whose
// path is clean and run pkg via that.
const pkgBin = require.resolve('@yao-pkg/pkg/lib-es5/bin.js');
fs.mkdirSync(path.join(ROOT, path.dirname(OUTPUT)), { recursive: true });

let pkgRoot = ROOT;
let stagingLink = null;
if (/[(){}[\]*?!]/.test(ROOT)) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-exe-'));
  stagingLink = path.join(tmp, 'app');
  // 'junction' keeps this working on Windows without admin rights.
  fs.symlinkSync(ROOT, stagingLink, process.platform === 'win32' ? 'junction' : 'dir');
  pkgRoot = stagingLink;
  console.log(`\n▸ project path contains glob metacharacters — staging pkg via ${stagingLink}`);
}

try {
  run('pkg (bundle -> executable)', process.execPath, [
    pkgBin,
    path.join(pkgRoot, 'build', 'server.cjs'),
    '--config', path.join(pkgRoot, 'package.json'),
    '--targets', TARGETS,
    '--output', path.join(pkgRoot, OUTPUT),
    // A dep (brotli, via pdfkit->fontkit) can't be V8-bytecode-compiled; ship it
    // as plain source instead of silently dropping it from the executable.
    '--fallback-to-source',
  ]);
} finally {
  if (stagingLink) fs.rmSync(path.dirname(stagingLink), { recursive: true, force: true });
}

// 5. .env template for the target machine — placeholders only, never secrets.
const envExample = `# Monkey Mayhem — put this file, renamed to ".env", NEXT TO the executable.
# --- PostgreSQL on THIS machine ---
PGHOST=localhost
PGPORT=5432
PGDATABASE=postgresdb
PGUSER=postgres
PGPASSWORD=your-postgres-password-here

# --- Auth: use a long random string (e.g. from a password generator) ---
JWT_SECRET=put-a-long-random-secret-here
# 8h is a reasonable maximum for a staff session.
JWT_EXPIRES_IN=8h

# --- Server ---
PORT=9000
TRUST_PROXY=
ADMIN_PATH=

# --- Google reviews on the public website (optional) ---
# Leave blank to show the site's own curated quotes instead.
GOOGLE_MAPS_API_KEY=
GOOGLE_PLACE_ID=
GOOGLE_PLACES_PHOTOS=0
GOOGLE_PLACES_CACHE_SECONDS=0
`;
fs.writeFileSync(path.join(ROOT, path.dirname(OUTPUT), '.env.example'), envExample);

console.log(`\n✓ Built ${OUTPUT} (${TARGETS})`);
console.log('  Ship it with a filled-in .env (see .env.example next to it).');
