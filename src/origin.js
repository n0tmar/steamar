'use strict';

// origin_allowed(req): a loopback Host always, and for a write our own origin or no origin at all.
// It is not authentication; the engine port has none.
// Trap: a request with no Origin header is allowed, because the native shell never sends one.

// Who may talk to the engine. It listens on a loopback port with no authentication, so the browser's
// same-origin policy is the only lock on it. Two attacks go round that lock, and each has its own check.
//
// Cross-origin writes. A `text/plain` body needs no preflight, so any site the person visits could POST
// here and drive a local action: add a game, rewrite settings, open a link. A write is therefore only
// accepted from our own UI or from a caller with no origin at all - the native shell proxies over
// WinHTTP and never sends one, and neither do the test harnesses.
//
// DNS rebinding. A hostile page points its own name at 127.0.0.1, after which the browser treats the
// engine as the page's own origin: Origin and Host both read `evil.example:8788`, so the check above
// passes, and GETs are never checked at all. A browser always sends the name it was given, so the
// engine refuses every request whose Host is not a loopback name.

const OWN_ORIGINS = new Set(['https://steamar.cc', 'https://www.steamar.cc']);
const LOOPBACK_HOST = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/i;

function origin_allowed(req) {
  const host = String(req.headers.host || '').toLowerCase();
  if (!LOOPBACK_HOST.test(host)) return false;
  if (req.method === 'GET' || req.method === 'HEAD') return true;
  const origin = req.headers.origin;
  if (origin === undefined) return true;          // native shell, curl, the test suite
  if (!origin || origin === 'null') return false; // opaque origin: a sandboxed or file:// page
  try {
    const parsed = new URL(origin);
    return OWN_ORIGINS.has(parsed.origin) || parsed.host.toLowerCase() === host;
  } catch {
    return false;
  }
}

module.exports = { origin_allowed };
