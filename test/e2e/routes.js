// End-to-end smoke over the engine: every route, read-only ones with real args, writes against a
// throwaway copy so nothing in the user's Steam install is touched.
const path = require('node:path');
const fs = require('node:fs');

const BASE = 'http://127.0.0.1:8788';
const results = [];

const call = async (method, route, body, expect = 200) => {
  const t0 = Date.now();
  let status = 0;
  let text = '';
  try {
    const res = await fetch(BASE + route, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(45000),
    });
    status = res.status;
    text = await res.text();
  } catch (err) {
    status = -1;
    text = err.message;
  }
  const ms = Date.now() - t0;
  const ok = status === expect;
  results.push({ ok, method, route, status, ms, size: text.length, sample: text.slice(0, 90) });
  return { status, text, ms };
};

(async () => {
  const json = (s) => { try { return JSON.parse(s); } catch { return null; } };

  // A signed-out PC is refused the two reads that need a person behind the device. That is the door
  // working, so the expectation follows the account instead of asserting against it.
  const account = json((await call('GET', '/api/account')).text);
  const linked = Boolean(account && account.account && account.account.linked);
  const gated = linked ? 200 : 403;

  // ---- reads
  const status = json((await call('GET', '/api/status')).text);
  const library = json((await call('GET', '/api/library')).text);
  const settings = json((await call('GET', '/api/settings')).text);
  await call('GET', '/api/repair');
  await call('GET', '/api/setup');
  await call('GET', '/api/fixes?limit=5');
  await call('GET', '/api/fixes/scan');
  await call('GET', '/api/fixes/link?id=18295', null, gated);
  await call('GET', '/api/names?ids=1260320,4715160');
  const search = json((await call('GET', '/api/search?q=portal')).text);
  const store = json((await call('GET', '/api/store')).text);
  await call('GET', '/api/package?appid=1260320', null, gated);
  await call('GET', '/api/app?appid=1260320');
  await call('GET', '/api/reach');
  const selftest = json((await call('GET', '/api/selftest')).text);
  await call('POST', '/api/clipboard', { text: 'steamar e2e' });
  await call('GET', '/img/1260320.jpg');
  await call('GET', '/img/cap/1260320.jpg');
  await call('GET', '/img/of/18295.jpg');

  // ---- validation and error paths
  await call('GET', '/api/fixes/link?id=999999999', null, 404);   // unknown release id
  await call('POST', '/api/add', { appid: 'not-a-number' }, 400);
  await call('GET', '/api/app?appid=abc', null, 400);
  await call('GET', '/api/nope', null, 404);
  await call('POST', '/api/open-link', { url: 'file:///C:/Windows/System32/calc.exe' }, 400);
  await call('POST', '/api/reveal', { target: 'nope' }, 400);

  // ---- writes that only touch app state
  await call('POST', '/api/log', { level: 'info', message: 'e2e smoke' });
  await call('POST', '/api/settings', settings || {});

  // ---- report
  const bad = results.filter((r) => !r.ok);
  for (const r of results) {
    console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${String(r.status).padStart(3)} ${String(r.ms).padStart(5)}ms ${r.method.padEnd(4)} ${r.route}${r.ok ? '' : ` <- ${r.sample}`}`);
  }
  console.log(`\n${results.length - bad.length}/${results.length} routes behaved`);

  // shapes worth asserting
  const checks = [
    ['status has steam root', Boolean(status && (status.steam_root || status.paths))],
    ['library has games', Boolean(library && Array.isArray(library.games))],
    ['search returns results', Boolean(search && Array.isArray(search.results) && search.results.length)],
    ['selftest answers five checks', Boolean(selftest && Array.isArray(selftest.checks) && selftest.checks.length === 5)],
    ['store has banner and shelves', Boolean(store && (store.banner && store.shelves))],
    ['fixes rows carry state + image', Boolean(json((await fetch(`${BASE}/api/fixes?limit=3`).then((r) => r.text()))).rows?.every((r) => r.state && (r.image || r.poster_local)))],
  ];
  for (const [label, pass] of checks) console.log(`${pass ? 'ok  ' : 'FAIL'} ${label}`);
})();
