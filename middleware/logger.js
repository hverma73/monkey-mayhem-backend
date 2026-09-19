const RESET = '\x1b[0m';
const DIM   = '\x1b[2m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED   = '\x1b[31m';
const CYAN  = '\x1b[36m';

function statusColor(code) {
  if (code >= 500) return RED;
  if (code >= 400) return YELLOW;
  return GREEN;
}

function timestamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 23);
}

// Logs every request: method, path, status, duration, and authenticated user if present.
export function requestLogger(req, res, next) {
  const start = Date.now();

  res.on('finish', () => {
    const ms      = Date.now() - start;
    const color   = statusColor(res.statusCode);
    const user    = req.user ? ` ${DIM}[${req.user.username}]${RESET}` : '';
    const method  = req.method.padEnd(6);
    const status  = `${color}${res.statusCode}${RESET}`;

    console.log(
      `${DIM}${timestamp()}${RESET}  ${CYAN}${method}${RESET} ${req.originalUrl}  ${status}  ${DIM}${ms}ms${RESET}${user}`
    );
  });

  next();
}

// Logs unhandled errors before Express sends the response.
//
// Only 5xx gets a stack. A 4xx is the caller's fault and its stack tells us
// nothing — and since POST /api/leads is public, a flood of malformed JSON
// would otherwise write one stack trace per request to stdout, which in the
// packaged executable is a console window somebody at the club is looking at.
export function errorLogger(err, req, res, next) {
  const status = err.status || err.statusCode || 500;
  const head = `${RED}[ERROR]${RESET} ${DIM}${timestamp()}${RESET}  ${req.method} ${req.originalUrl}`;
  if (status >= 500) {
    console.error(`${head}\n  ${err.stack || err.message}`);
  } else {
    console.error(`${head}  ${DIM}${status} ${err.type || err.message}${RESET}`);
  }
  next(err);
}
