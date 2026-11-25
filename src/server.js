'use strict';

// The engine's entry point: the local HTTP server the window (or a browser) talks to on 127.0.0.1.
// It checks the origin, serves the page's files and the cover art, and hands /api calls to routes.js.
// The work itself lives in the modules routes.js calls. The native shell starts this file by name.
// Trap: the port is fixed (8788 unless PORT is set) because the shell and the origin check expect it.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const paths = require('./paths');
const api = require('./api');
const { origin_allowed } = require('./origin');
const images = require('./images');
const denuvo = require('./denuvo');
const onlinefix = require('./onlinefix');
const presence = require('./presence');
const { routes, fetch_new } = require('./routes');

const PORT = paths.engine_port();
const HOST = '127.0.0.1';
const UI = path.join(paths.project_root(), 'ui');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };

function send(res, status, body, type = 'application/json; charset=utf-8', headers = {}) {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...headers });
  res.end(payload);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const route = `${req.method} ${url.pathname}`;

  if (!origin_allowed(req)) return send(res, 403, { error: 'this page may not drive the app' });

  if (req.method === 'GET' && url.pathname.startsWith('/img/')) {
    const m = /^\/img\/(?:(cap|hero|tall|of)\/)?(\d{1,12})\.jpg$/.exec(url.pathname);
    const site = url.pathname.startsWith('/img/site/') ? url.pathname.slice('/img/site/'.length) : null;
    if (!m && !site) return send(res, 404, 'not found', 'text/plain');
    const kind = m ? m[1] || 'h' : 'site';
    // 'of' is the release's own poster, the fallback for titles Steam has no art for.
    const release = kind === 'of' ? onlinefix.find(m[2]) : null;
    const hit = site ? await images.site_ensure(site)
      : kind === 'of' ? (release?.poster ? await images.poster_ensure(m[2], release.poster) : null)
        : await images.ensure(kind, m[2]);
    if (!hit) return send(res, 404, 'no art', 'text/plain', { 'cache-control': 'no-store' });
    const st = fs.statSync(hit.file);
    const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { etag, 'cache-control': 'public, max-age=31536000, immutable' });
      return res.end();
    }
    return send(res, 200, fs.readFileSync(hit.file), hit.type, {
      etag,
      'cache-control': 'public, max-age=31536000, immutable',
    });
  }

  if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
    const file = path.join(UI, rel);
    if (!file.startsWith(UI) || !paths.exists(file)) return send(res, 404, 'not found', 'text/plain');

    const st = fs.statSync(file);
    const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { etag, 'cache-control': 'no-cache' });
      return res.end();
    }
    return send(res, 200, fs.readFileSync(file), TYPES[path.extname(file)] || 'application/octet-stream', {
      etag,
      'last-modified': st.mtime.toUTCString(),
      'cache-control': 'no-cache',
    });
  }

  const handler = routes[route];
  if (!handler) return send(res, 404, { error: `no route ${route}`, code: 'no_route' });

  try {
    send(res, 200, await handler(req, url));
  } catch (err) {
    // `code` rides along so a caller can tell "no data for this id" from "the service is down"
    // without matching on prose. A service that cannot be reached is 503, not 500: nothing in this
    // process failed, the one thing it depends on is absent.
    const code = err.code || null;
    const status = err.status || (code === 'unreachable' ? 503 : 500);
    send(res, status, { error: err.message, code });
  }
});

server.on('error', (err) => {
  // Same courtesy as the data service: a port that is already taken is a sentence, not a stack.
  if (err.code === 'EADDRINUSE') {
    console.error(`SteaMar app: ${HOST}:${PORT} is already in use - another engine is running.`);
    console.error(`  netstat -ano | findstr ":${PORT}"     then   taskkill /f /pid <pid>`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, HOST, () => {
  // Discord's window on this PC, if there is one: it says the app is running for as long as the
  // engine is. Nothing waits on it and nothing breaks without it.
  presence.start();
  paths.steam_running(); // prime the tasklist cache so the first /api/status is a warm read

  // The service answers with the counts, the Denuvo list and the fix index; hydrate the two local
  // indexes from that answer so every panel that asks synchronously has something to show. Nothing
  // waits on this: the window opens either way and says so when the service is missing.
  api.warm()
    .then(() => Promise.all([denuvo.hydrate(), onlinefix.hydrate()]))
    .then(() => {
      // A release newer than this build is downloaded before anybody asks. The chip in the rail says
      // when it is ready; the window closes only when that chip is pressed.
      fetch_new();
      const counts = api.counters();
      console.log(`service            ${api.state().enrolled ? `device ${api.state().device_id}` : 'not enrolled'}`);
      console.log(`titles             ${counts.addable.toLocaleString()} addable of ${counts.titles.toLocaleString()} known`);
      console.log(`denuvo list        ${denuvo.stats().count} titles`);
      console.log(`fixes index        ${onlinefix.load().items.length} releases`);
    })
    .catch((err) => console.log(`service            ${err.message}`));

  console.log(`SteaMar app      http://${HOST}:${PORT}`);
  console.log(`steam root         ${paths.steam_root()}`);
  console.log(`stplug-in          ${paths.stplug_in()}`);
  console.log(`steam              ${paths.steam_running() ? 'running' : 'stopped'}`);
});

// Discord drops the activity when the pipe closes, so this is only a courtesy; the process dying
// does the same thing.
process.on('exit', () => presence.stop());
