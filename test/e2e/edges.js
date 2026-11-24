// The three cases the first harness mis-called, plus a couple of sharper ones.
const BASE = 'http://127.0.0.1:8788';

const hit = async (method, route, body, headers = {}) => {
  const res = await fetch(BASE + route, {
    method,
    headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  return { status: res.status, text: await res.text() };
};

(async () => {
  const cases = [
    ['unknown release id', 'GET', '/api/fixes/link?id=999999999'],
    ['bad appid', 'GET', '/api/app?appid=abc'],
    ['unknown route', 'GET', '/api/nope'],
    ['traversal on the static handler', 'GET', '/../package.json'],
    ['traversal through img', 'GET', '/img/..%2f..%2fpackage.json'],
    ['open-link with a file url', 'POST', '/api/open-link', { url: 'file:///C:/Windows/System32/calc.exe' }],
    ['open-link with a javascript url', 'POST', '/api/open-link', { url: 'javascript:alert(1)' }],
    ['open-link with a quote-trick', 'POST', '/api/open-link', { url: 'https://a.com/x" & calc & "' }],
    ['reveal a path outside the project', 'POST', '/api/reveal', { target: 'C:\\Windows' }],
    ['add a non-numeric appid', 'POST', '/api/add', { appid: '../../etc/passwd' }],
    ['remove with no body', 'POST', '/api/remove', {}],
    ['settings with rubbish', 'POST', '/api/settings', { steam_root: 42, stplug_in: null }],
  ];
  for (const [label, method, route, body] of cases) {
    try {
      const r = await hit(method, route, body);
      console.log(`${String(r.status).padStart(3)} ${label.padEnd(38)} ${r.text.slice(0, 110).replace(/\s+/g, ' ')}`);
    } catch (err) {
      console.log(`ERR ${label}: ${err.message}`);
    }
  }

  // a POST from a foreign origin should not be honoured
  const cross = await fetch(`${BASE}/api/open-link`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
    body: JSON.stringify({ url: 'https://example.com/' }),
  });
  console.log(`${String(cross.status).padStart(3)} cross-origin POST open-link (want 403)  ${cross.ok ? 'STILL ACCEPTED' : 'refused'}`);

  // the native shell sends no origin at all, and that must keep working
  const native = await fetch(`${BASE}/api/log`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ level: 'info', message: 'origin-less POST' }),
  });
  console.log(`${String(native.status).padStart(3)} origin-less POST /api/log (want 200, this is the shell)`);

  // our own UI is served from the virtual host, so it must not be locked out either
  const own = await fetch(`${BASE}/api/log`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: `http://${new URL(BASE).host}` },
    body: JSON.stringify({ level: 'info', message: 'same-host POST' }),
  });
  console.log(`${String(own.status).padStart(3)} same-host POST /api/log (want 200)`);

  const opaque = await fetch(`${BASE}/api/log`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'null' },
    body: JSON.stringify({ level: 'info', message: 'opaque origin POST' }),
  });
  console.log(`${String(opaque.status).padStart(3)} origin:null POST /api/log (want 403)`);
})();
