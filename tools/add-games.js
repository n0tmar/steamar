'use strict';

// Batch add: resolve app ids (arguments, --trending, --index, --from, --search) and write each
// <appid>.lua into stplug-in through the engine's POST /api/add, starting an engine if none answers.
// Never calls /api/install, so nothing opens the Steam installer dialog. Add-only by construction.
// Trap: --trending and --index read files under ManifestHub/data that a fresh copy does not have.

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT || 8788);
const BASE = `http://${HOST}:${PORT}`;
const TRENDING = path.join(ROOT, 'ManifestHub', 'data', 'trending-data.json');
const INDEX = path.join(ROOT, 'ManifestHub', 'data', 'download-counts.json');

function parse_args(argv) {
  const args = { ids: [], from: [], dry: false, trending: 0, index: [], limit: 5 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry') args.dry = true;
    else if (a === '--trending') {
      const n = Number(argv[i + 1]);
      args.trending = Number.isInteger(n) && n > 0 ? (i++, n) : 5;
    } else if (a === '--from') args.from.push(argv[++i]);
    else if (a === '--index') args.index.push(argv[++i]);
    else if (a === '--limit') args.limit = Number(argv[++i]) || 5;
    else if (a === '--search') args.from.push(`search:${argv[++i]}`);
    else if (/^\d+$/.test(a)) args.ids.push(a);
    else if (a.startsWith('--')) throw new Error(`unknown argument: ${a}`);
    else args.from.push(`search:${a}`);
  }
  return args;
}

// Names from the local download index: 17k games the community actually pulls, matched offline so a
// title can be found without the store answering. Popularity decides the order, --limit the count.
function index_matches(term, limit) {
  if (!fs.existsSync(INDEX)) throw new Error(`no download index at ${INDEX} - run npm run bootstrap`);
  const raw = JSON.parse(fs.readFileSync(INDEX, 'utf8'));
  const needle = String(term).toLowerCase();
  const hits = [];
  for (const g of Object.values(raw)) {
    if (!g || !g.mainAppId || !g.gameName) continue;
    if (String(g.gameName).toLowerCase().includes(needle)) {
      hits.push({ appid: String(g.mainAppId), hint: g.gameName, count: Number(g.count) || 0 });
    }
  }
  hits.sort((a, b) => b.count - a.count);
  return hits.slice(0, limit).map((h) => ({ appid: h.appid, hint: h.hint }));
}

// trending-data.json is [{appId, gameName, count}] newest-first; the names can be mojibake,
// so they are only ever a label - the engine's own name wins.
function read_trending(n) {
  if (!fs.existsSync(TRENDING)) throw new Error(`no trending list at ${TRENDING}`);
  const list = JSON.parse(fs.readFileSync(TRENDING, 'utf8'));
  return list.slice(0, n).map((g) => ({ appid: String(g.appId), hint: g.gameName }));
}

function read_list(file) {
  const text = fs.readFileSync(path.resolve(ROOT, file), 'utf8');
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const [id, ...rest] = line.split(/[,;\t]|\s{2,}/);
    if (/^\d+$/.test(id.trim())) out.push({ appid: id.trim(), hint: rest.join(' ').trim() });
    else out.push({ appid: '', hint: line });
  }
  return out;
}

async function call(method, route, body) {
  const res = await fetch(BASE + route, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { error: text.slice(0, 200) }; }
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

async function engine_up() {
  try { await call('GET', '/api/status'); return true; } catch { return false; }
}

async function ensure_engine() {
  if (await engine_up()) return null;
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  child.stdout.resume();
  child.stderr.resume();
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    if (await engine_up()) return child;
  }
  child.kill();
  throw new Error(`engine did not answer on ${BASE} within 20s`);
}

async function resolve_search(term) {
  const found = await call('GET', `/api/search?q=${encodeURIComponent(term)}`);
  const items = Array.isArray(found) ? found : found.results || [];
  if (!items.length) throw new Error(`no store result for "${term}"`);
  const pick = items[0];
  return { appid: String(pick.appid || pick.id), hint: pick.name || term };
}

function pad(v, n) { return String(v ?? '').padEnd(n); }

async function main() {
  const args = parse_args(process.argv.slice(2));
  let queue = args.ids.map((appid) => ({ appid, hint: '' }));

  // --trending expands to the whole list when --dry is not combined with an explicit count
  if (args.trending) queue = queue.concat(read_trending(args.trending));
  for (const term of args.index) queue = queue.concat(index_matches(term, args.limit));
  for (const spec of args.from) {
    queue = queue.concat(spec.startsWith('search:') ? [] : read_list(spec));
  }

  const searches = args.from.filter((s) => s.startsWith('search:')).map((s) => s.slice(7));
  if (!queue.length && !searches.length) {
    throw new Error('nothing to add. use: add-games <appid...> | --trending [n] | --from <file> | --search "name"');
  }

  const spawned = await ensure_engine();
  const rows = [];
  let failed = 0;
  try {
    for (const term of searches) {
      try { queue.push(await resolve_search(term)); } catch (err) {
        failed++; rows.push({ appid: '-', name: term, status: `search failed: ${err.message}` });
      }
    }

    for (const item of queue) {
      if (!/^\d+$/.test(item.appid)) {
        failed++; rows.push({ appid: '-', name: item.hint || '?', status: 'no app id' });
        continue;
      }
      try {
        if (args.dry) {
          const pkg = await call('GET', `/api/package?appid=${item.appid}`);
          rows.push({
            appid: item.appid, name: pkg.name || item.hint,
            depots: pkg.depots ? pkg.depots.length : 0,
            keys: (pkg.depots || []).filter((d) => d.key).length,
            status: 'would add',
          });
        } else {
          const r = await call('POST', '/api/add', { appid: item.appid });
          rows.push({
            appid: r.appid, name: r.name || item.hint,
            depots: r.depots, keys: r.keys, status: `added (${r.reload})`,
          });
        }
      } catch (err) {
        failed++;
        rows.push({ appid: item.appid, name: item.hint, status: `failed: ${err.message}` });
      }
    }
  } finally {
    if (spawned) spawned.kill();
  }

  const w = (k) => Math.max(k.length, ...rows.map((r) => String(r[k] ?? '').length));
  const wa = w('appid'), wn = w('name'), wd = 6, wk = 4, ws = w('status');
  console.log(`${pad('appid', wa)}  ${pad('name', wn)}  ${pad('depots', wd)}  ${pad('keys', wk)}  status`);
  console.log(`${'-'.repeat(wa)}  ${'-'.repeat(wn)}  ${'-'.repeat(wd)}  ${'-'.repeat(wk)}  ${'-'.repeat(ws)}`);
  for (const r of rows) {
    console.log(`${pad(r.appid, wa)}  ${pad(r.name, wn)}  ${pad(r.depots ?? '', wd)}  ${pad(r.keys ?? '', wk)}  ${r.status}`);
  }
  console.log(`\n${rows.length - failed} ok, ${failed} failed${args.dry ? ' (dry run, nothing written)' : ''}`);
  if (!args.dry && rows.length - failed) {
    console.log('no installer was opened. to undo one: node src/drop.js --file <appid>.lua --remove  (backups stay in out/backup)');
  }
  process.exitCode = failed ? 1 : 0;
}

main().catch((err) => {
  console.error(`add-games: ${err.message}`);
  process.exitCode = 2;
});
