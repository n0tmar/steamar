'use strict';

// Measures what a first paint costs: the page, its styles and scripts, two API calls, the library
// covers and the banner heroes, fetched from a running engine; prints bytes and milliseconds.
// It starts no engine; set BASE if it is not on http://127.0.0.1:8788.
// Trap: requests run one after another, so the total is serial, not what a browser would see.

const path = require('node:path');
const { page_scripts, page_styles } = require('./dom');

const BASE = process.env.BASE || 'http://127.0.0.1:8788';

async function timed(path) {
  const start = process.hrtime.bigint();
  const res = await fetch(BASE + path);
  const bytes = Buffer.from(await res.arrayBuffer()).length;
  return { path, bytes, ms: Number(process.hrtime.bigint() - start) / 1e6, status: res.status };
}

(async () => {
  const started = Date.now();
  const core = [];
  const scripts = page_scripts(path.join(__dirname, '..', 'ui')).map((name) => `/${name}`);
  const styles = page_styles(path.join(__dirname, '..', 'ui')).map((name) => `/${name}`);
  for (const p of ['/', ...styles, ...scripts, '/api/status', '/api/library']) core.push(await timed(p));

  const lib = await (await fetch(`${BASE}/api/library`)).json();
  let img_bytes = 0;
  let img_ms = 0;
  let n = 0;
  for (const g of lib.games) {
    if (!g.image) continue;
    const hit = await timed(g.image);
    if (hit.status === 200) { img_bytes += hit.bytes; img_ms += hit.ms; n++; }
  }

  // Home also pulls one hero per banner slide plus lazy shelf art; report the banner separately.
  const store = await (await fetch(`${BASE}/api/store`)).json();
  let hero_bytes = 0;
  let hero_ms = 0;
  for (const slide of store.banner) {
    const hit = await timed(slide.hero);
    if (hit.status === 200) { hero_bytes += hit.bytes; hero_ms += hit.ms; }
  }

  const rows = [...core, { path: `${n} covers`, bytes: img_bytes, ms: img_ms }, { path: `${store.banner.length} heroes`, bytes: hero_bytes, ms: hero_ms }];
  for (const r of rows) {
    console.log(String(r.path).padEnd(14), String(r.bytes).padStart(8), 'B', String(r.ms.toFixed(1)).padStart(7), 'ms');
  }
  console.log('-'.repeat(40));
  console.log('payload'.padEnd(14), String(rows.reduce((s, r) => s + r.bytes, 0)).padStart(8), 'B');
  console.log('serial total'.padEnd(14), String(Date.now() - started).padStart(8), 'ms');
  console.log('game rows'.padEnd(14), String(lib.games.filter((g) => g.kind === 'game').length).padStart(8), ' server scan', lib.ms, 'ms');
})();
