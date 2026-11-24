'use strict';

// The fixes catalogue: the service keeps the release index and api.js mirrors it into
// out/api/fixes.json, so the tab draws and searches without asking the network per keystroke.
// What a click teaches is kept in out/api/fix-flags.json. Nothing is downloaded here.
// Trap: flags record positives only and are merged over the mirror, so a refresh cannot wipe them.

const fs = require('node:fs');
const path = require('node:path');
const paths = require('./paths');
const api = require('./api');
const scan = require('./scan');
const images = require('./images');
const denuvo = require('./denuvo');

const REFRESH_DAYS = 7;
const MIRROR = () => path.join(paths.out_dir(), 'api', 'fixes.json');
const FLAGS = () => path.join(paths.out_dir(), 'api', 'fix-flags.json');
const CHARTS = () => path.join(paths.out_dir(), 'cache', 'trending.json');

let cache = { mtime: 0, flags: 0, data: { fetched: null, total: 0, items: [] } };

// "Trending" is not a section on the release site; it is what people are actually playing, straight
// from Steam's live chart. Cached for hours, refreshed in the background, empty when offline.
let charts = { read_at: 0, fetched: 0, ids: new Set() };

function trending_ids() {
  if (!charts.read_at) {
    try {
      const rec = JSON.parse(fs.readFileSync(CHARTS(), 'utf8'));
      charts = { read_at: Date.now(), fetched: rec.fetched || 0, ids: new Set((rec.ids || []).map(String)) };
    } catch {
      charts = { read_at: Date.now(), fetched: 0, ids: new Set() };
    }
  }
  if (Date.now() - charts.fetched > 6 * 60 * 60 * 1000) refresh_trending();
  return charts.ids;
}

async function refresh_trending() {
  if (refresh_trending.busy) return;
  refresh_trending.busy = true;
  try {
    const res = await fetch('https://api.steampowered.com/ISteamChartsService/GetMostPlayedGames/v1/', {
      headers: { 'user-agent': 'SteaMar/0.3 (+local)' },
      signal: AbortSignal.timeout(10000),
    });
    const body = await res.json();
    const ids = (body?.response?.ranks || [])
      .map((r) => String(r.appid))
      .filter((a) => /^\d+$/.test(a))
      .slice(0, 120);
    if (!ids.length) return;
    const rec = { fetched: Date.now(), ids };
    fs.mkdirSync(path.dirname(CHARTS()), { recursive: true });
    fs.writeFileSync(CHARTS(), JSON.stringify(rec), 'utf8');
    charts = { read_at: Date.now(), fetched: rec.fetched, ids: new Set(ids) };
  } catch {
    // offline, or the chart is down: the tab simply has no trending shelf this run
    charts = { read_at: Date.now(), fetched: Date.now(), ids: charts.ids };
  } finally {
    refresh_trending.busy = false;
  }
}

function load() {
  const file = MIRROR();
  if (!paths.exists(file)) return cache.data;
  const st = fs.statSync(file);
  const flag_st = paths.exists(FLAGS()) ? fs.statSync(FLAGS()).mtimeMs : 0;
  if (st.mtimeMs === cache.mtime && flag_st === cache.flags) return cache.data;
  try {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    const body = doc.body || doc;
    const flags = read_flags();
    const items = (Array.isArray(body.items) ? body.items : []).map((item) => {
      const flag = flags[String(item.id)];
      return flag ? { ...item, ...flag } : item;
    });
    cache = {
      mtime: st.mtimeMs,
      flags: flag_st,
      data: { fetched: body.fetched || null, total: items.length, items },
    };
  } catch {
    cache = { mtime: st.mtimeMs, flags: flag_st, data: { fetched: null, total: 0, items: [], error: 'the fixes index did not parse' } };
  }
  return cache.data;
}

// What the last click taught us, kept beside the mirror rather than inside it: a refresh from the
// service must never wipe a judgement made on this machine.
function read_flags() {
  try {
    const body = JSON.parse(fs.readFileSync(FLAGS(), 'utf8'));
    return body && typeof body === 'object' ? body : {};
  } catch {
    return {};
  }
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

function search(term, limit = 40) {
  const q = norm(term);
  const { items } = load();
  if (!q) return items.slice(0, limit);
  const scored = [];
  for (const item of items) {
    const n = norm(item.title);
    const at = n.indexOf(q);
    if (at < 0) continue;
    scored.push({ item, rank: (at === 0 ? 0 : 1) + Math.min(3, n.length / 60) });
  }
  return scored.sort((a, b) => a.rank - b.rank).slice(0, limit).map((s) => s.item);
}

const find = (id) => load().items.find((i) => String(i.id) === String(id)) || null;
const by_appid = (appid) => load().items.find((i) => String(i.appid) === String(appid)) || null;

// What a click teaches us. Resolving the link means we reached the host and read a file name that
// says "fix": that is the same judgement server/tools/fix-flags.js makes from the same table, so it is
// worth keeping. Only positives are recorded — a failure could be a bad night on the host, and
// hiding a release on a failed request is the one mistake this tab must not make.
function remember(id, link) {
  if (!link || !link.url) return false;
  if (!find(id)) return false;
  const flags = read_flags();
  flags[String(id)] = {
    has_fix: true,
    fix_file: link.name || flags[String(id)]?.fix_file || null,
    fix_url: link.url,
    fix_checked_at: new Date().toISOString(),
    fix_hidden_at: undefined,
  };
  const file = FLAGS();
  try {
    paths.ensure_dir(path.dirname(file));
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(flags, null, 1), 'utf8');
    fs.renameSync(`${file}.tmp`, file);
  } catch { return false; }
  cache.flags = 0;  // the next read picks up the file we just wrote
  return true;
}

// Asked at start, each time the tab opens, and once somebody is signed in: the list is for members, so
// a PC that signed in after the engine started was refused it at boot. api.fixes() only goes to the
// network when its copy is an hour old, and a new copy is a new file, which load() notices by itself.
let asking = null;
function hydrate() {
  if (!asking) asking = api.fixes().then(() => load()).finally(() => { asking = null; });
  return asking;
}

const busy = () => Boolean(asking);

function stale() {
  const { fetched } = load();
  if (!fetched) return true;
  return Date.now() - Date.parse(fetched) > REFRESH_DAYS * 24 * 60 * 60 * 1000;
}

// Joins the catalogue with what is on disk and with stplug-in, so the tab can show three states the
// index alone can never know: installed, needs update, and both paths claiming the same title.
function view({ limit = 200 } = {}) {
  const { items, fetched, total, error } = load();
  const hot = trending_ids();
  const disk = scan.scan_common();
  const by_name = new Map(disk.map((d) => [norm(d.name), d]));
  const by_id = new Map(disk.filter((d) => d.real_appid).map((d) => [String(d.real_appid), d]));

  const plug = paths.stplug_in();
  const scripts = new Set(
    (paths.exists(plug) ? fs.readdirSync(plug) : []).filter((f) => /\.lua$/i.test(f)).map((f) => path.basename(f, '.lua')),
  );

  // Only releases that carry a fix of their own. A page that offers nothing but the full game is
  // hidden: there is nothing for this tab to hand over.
  const usable = items.filter((item) => item.has_fix !== false);
  const rows = usable.slice(0, limit).map((item) => {
    const local = (item.appid && by_id.get(String(item.appid))) || by_name.get(norm(item.title)) || null;
    const in_library = Boolean(item.appid && scripts.has(String(item.appid)));
    const conflict = Boolean(local?.fix && in_library);
    let state = 'available';
    if (conflict) state = 'conflict';
    else if (local?.fix) state = local.api.present ? 'installed' : 'broken';
    else if (in_library) state = 'library';
    if (local?.fix && item.last_updated && local.installed_version && local.installed_version !== item.last_updated) state = 'update';
    return { ...item, state, local, in_library, denuvo: denuvo.has(item.appid, item.title), image: item.appid ? images.url(item.appid) : null, poster_local: item.poster ? `/img/of/${item.id}.jpg` : null, trending: Boolean(item.appid && hot.has(String(item.appid))) };
  });

  const counts = rows.reduce((acc, r) => ({ ...acc, [r.state]: (acc[r.state] || 0) + 1 }), {});
  return {
    fetched,
    total: usable.length,
    hidden: items.length - usable.length,
    error: error || null,
    stale: stale(),
    counts,
    rows,
    installed: disk.length,
  };
}

module.exports = { load, search, find, by_appid, stale, view, norm, remember, hydrate, busy };
