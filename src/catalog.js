'use strict';

// Steam store and SteamCMD lookups cached under out/cache: search, names, details, whether Steam still sells a game,
// and resolve_package(), which joins SteamCMD depots with the service's keys.
// It holds no keys of its own; they come from api.package_for().
// Trap: an app id must be digits before it names a cache file; resolve_package() throws with
// status 404 or 503, while app_details() never throws.

const fs = require('node:fs');
const path = require('node:path');
const paths = require('./paths');
const api = require('./api');

const UA = 'SteaMar/0.3 (+local)';
const INFO_TTL_MS = 24 * 60 * 60 * 1000;

// An app id is digits and nothing else. It names a cache file and sits inside a URL, and the engine
// takes it from a query string that any page open in the browser can fill, so it is checked before it
// is used for either. (A name like ../../../config/steam used to be written over as a cache file.)
const APPID = /^\d{1,12}$/;
const is_appid = (value) => APPID.test(String(value));
const bad_appid = () => Object.assign(new Error('appid must be digits'), { status: 400 });

function cache_dir(...parts) {
  const dir = path.join(paths.out_dir(), 'cache', ...parts);
  paths.ensure_dir(dir);
  return dir;
}

async function get_json(url) {
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function search_store(term) {
  const url = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(term)}&cc=us&l=en`;
  const body = await get_json(url);
  const items = Array.isArray(body.items) ? body.items : [];
  return items
    .filter((i) => i.type === 'app')
    .map((i) => ({
      appid: String(i.id),
      name: i.name,
      image: i.tiny_image || null,
      platforms: i.platforms || {},
    }));
}

// api.steamcmd.net mirrors the SteamCMD app_info_print tree; cache on disk for a day.
async function fetch_info(appid) {
  if (!is_appid(appid)) throw bad_appid();
  const file = path.join(cache_dir('appinfo'), `${appid}.json`);
  if (paths.exists(file)) {
    try {
      const cached = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Date.now() - cached.fetched < INFO_TTL_MS && cached.info) return cached.info;
    } catch { /* fall through to a fresh fetch */ }
  }
  const body = await get_json(`https://api.steamcmd.net/v1/info/${appid}`);
  const info = body?.data?.[String(appid)];
  if (!info) throw new Error(`no appinfo for ${appid}`);
  fs.writeFileSync(file, JSON.stringify({ fetched: Date.now(), info }), 'utf8');
  return info;
}

// Windows depots with a public manifest. oslist absent means all platforms.
function windows_depots(info) {
  const depots = info.depots || {};
  const out = [];
  for (const [id, d] of Object.entries(depots)) {
    if (!/^\d+$/.test(id)) continue; // `branches` and `privatebranches` are metadata keys, not depots
    const oslist = d.config?.oslist;
    if (oslist && !/\bwindows\b/i.test(oslist)) continue;
    out.push({
      depot: id,
      manifest: d.manifests?.public?.gid || null,
      size: d.manifests?.public?.size || null,
      shared_from: d.depotfromapp || null,
      dlc: d.dlcappid || null,
      name: d.name || null,
    });
  }
  return out;
}

const NEG_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Steam's store records for many app ids, fifty per call, keyed by app id as a string. The answer is
// in English, and an app taken off the store answers `unlisted: true`.
async function store_items(ids, data_request = {}) {
  const items = new Map();
  const wanted = ids.map(String).filter(is_appid);
  for (let i = 0; i < wanted.length; i += 50) {
    const input = {
      ids: wanted.slice(i, i + 50).map((appid) => ({ appid: Number(appid) })),
      context: { language: 'english', country_code: 'US', steam_realm: 1 },
      data_request,
    };
    const page = await get_json(`https://api.steampowered.com/IStoreBrowseService/GetItems/v1/?input_json=${encodeURIComponent(JSON.stringify(input))}`);
    for (const item of page?.response?.store_items || []) items.set(String(item.appid), item);
  }
  return items;
}

// The app ids in `ids` that Steam took off its store. A store that does not answer names none: a
// missing label is better than a wrong one.
async function removed_from_store(ids) {
  const items = await store_items(ids).catch(() => new Map());
  return new Set([...items].filter(([, item]) => item.unlisted).map(([appid]) => appid));
}

// Returns {appid, name, image} for a real store app, or null for a depot / unknown id.
async function app_lookup(appid) {
  if (!is_appid(appid)) return null;
  const file = path.join(cache_dir('names'), `${appid}.json`);
  if (paths.exists(file)) {
    try {
      const cached = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (cached.name && 'type' in cached) return cached;
      if (cached.not_app && Date.now() - (cached.fetched || 0) < NEG_TTL_MS) return null;
    } catch { /* rewrite the entry */ }
  }

  const url = `https://store.steampowered.com/api/appdetails?appids=${appid}&l=en&filters=basic`;
  let data = null;
  for (let attempt = 0; attempt < 2 && !data; attempt++) {
    try {
      const body = await get_json(url);
      const entry = body?.[String(appid)];
      if (entry?.success && entry.data?.name) data = entry.data;
    } catch { /* retry once, then record the miss */ }
    if (!data) await new Promise((r) => setTimeout(r, 300));
  }

  if (!data) {
    fs.writeFileSync(file, JSON.stringify({ appid: String(appid), not_app: true, fetched: Date.now() }), 'utf8');
    return null;
  }

  const record = { appid: String(appid), name: data.name, image: data.header_image || null, type: data.type || null };
  fs.writeFileSync(file, JSON.stringify(record), 'utf8');
  return record;
}

async function app_name(appid) {
  if (!is_appid(appid)) return null;
  const hit = await app_lookup(appid);
  if (hit) return hit;
  // Delisted apps are absent from appdetails, which is where the title index earns its keep. The
  // index is a search on the service, not a table in this folder; the answer is kept beside the
  // store's own name cache so the next open costs nothing.
  const found = await api.search(appid, 1).then((r) => r?.results?.[0]?.name || null).catch(() => null);
  if (found) {
    const file = path.join(cache_dir('names'), `${appid}.json`);
    try { fs.writeFileSync(file, JSON.stringify({ appid: String(appid), name: found, image: null, type: null }), 'utf8'); } catch { /* read-only cache */ }
    return { appid: String(appid), name: found, image: null };
  }
  return { appid: String(appid), name: `app ${appid}`, image: null };
}

// The panel's "about" text: the store's own words for an app, cut down to what a drawer shows.
// A month is long enough to feel free and short enough to follow a game out of early access.
const DETAIL_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// The free verdict is the one field that can change under a cached record: a paid game goes free, a
// demo gets its own page, a free game ships. It is a single boolean, so it is re-asked on its own,
// once a day, with the small filters=basic call, while the prose keeps its month.
const FREE_TTL_MS = 24 * 60 * 60 * 1000;
const PLAYER_TAGS = ['Single-player', 'Multi-player', 'Co-op', 'Online Co-op', 'Local Co-op', 'Cross-Platform Multiplayer'];

// Store copy arrives as bbcode with the odd html tag in it, and every game writes its own.
function plain_text(html) {
  return String(html || '')
    .replace(/\[\/?[a-z*]+[^\]]*\]/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

// One small question about one app id: is it free today, and is it a game or a demo. filters=basic
// answers in about 6 KB instead of the whole store page, so a stale record can afford to ask.
async function free_now(id) {
  try {
    const body = await get_json(`https://store.steampowered.com/api/appdetails?appids=${id}&cc=us&l=en&filters=basic`);
    const entry = body?.[id];
    if (!entry?.success || !entry.data) return null;
    return { free: Boolean(entry.data.is_free), type: entry.data.type || null };
  } catch {
    return null;
  }
}

// Returns the facts a drawer can carry, or {missing:true} for an id the store will not talk about.
// A failure is not thrown: the panel has buttons to offer either way, and a description is a bonus.
async function app_details(appid) {
  const id = String(appid || '');
  if (!/^\d+$/.test(id)) return { appid: id, missing: true };

  const file = path.join(cache_dir('details'), `${id}.json`);
  let cached = null;
  if (paths.exists(file)) {
    try { cached = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { cached = null; }
  }

  if (cached && cached.fetched && Date.now() - cached.fetched < DETAIL_TTL_MS) {
    if (cached.free_at && Date.now() - cached.free_at < FREE_TTL_MS && 'removed' in cached) return cached;
    // The text is still good; the verdict is not. Ask, and keep the answer with the record so the
    // next open is free. A store that will not answer leaves the last verdict in place: a panel that
    // waits on a dead network is worse than a flag a day out of date.
    // Whether Steam still sells it is asked on the same clock: a game can be taken off the store.
    const [now, gone] = await Promise.all([free_now(id), removed_from_store([id])]);
    cached.removed = gone.has(id);
    if (now) {
      cached.free = now.free;
      if (now.type) cached.type = now.type;
    }
    // The basic answer carries no release date, so the month-old one stands. A date that has gone by
    // means the game shipped, whatever the record still says about it.
    if (cached.coming_soon && cached.release) {
      const when = Date.parse(cached.release);
      if (Number.isFinite(when) && when < Date.now()) cached.coming_soon = false;
    }
    cached.free_at = Date.now();
    try { fs.writeFileSync(file, JSON.stringify(cached), 'utf8'); } catch { /* the panel still gets it */ }
    return cached;
  }

  const url = `https://store.steampowered.com/api/appdetails?appids=${id}&cc=us&l=en`;
  let data = null;
  try {
    const body = await get_json(url);
    const entry = body?.[id];
    if (entry?.success && entry.data) data = entry.data;
  } catch { /* offline is not an error here */ }

  if (!data) {
    // A month-old record with real text beats an empty panel, so a refresh that fails hands back what
    // is already on disk instead of pretending the store never had a page for this id.
    return cached && cached.name ? cached : { appid: id, missing: true };
  }

  const record = {
    appid: id,
    fetched: Date.now(),
    free_at: Date.now(),
    name: data.name || null,
    description: plain_text(data.short_description || '').slice(0, 700),
    developers: (data.developers || []).slice(0, 2),
    publishers: (data.publishers || []).slice(0, 2),
    // Steam files "Free To Play" and "Early Access" as genres. Both say something else here, so
    // they are not repeated in the genre line.
    genres: (data.genres || [])
      .map((g) => g.description)
      .filter((g) => g && !/^(free to play|early access)$/i.test(g))
      .slice(0, 3),
    players: (data.categories || [])
      .map((c) => c.description)
      .filter((c) => PLAYER_TAGS.includes(c))
      .slice(0, 2),
    release: plain_text(data.release_date?.date || '') || null,
    coming_soon: Boolean(data.release_date?.coming_soon),
    free: Boolean(data.is_free),
    type: data.type || null,
    // Taken off the Steam store: there is nothing to get there, free or not, so the panel offers the add.
    removed: (await removed_from_store([id])).has(id),
  };
  fs.writeFileSync(file, JSON.stringify(record), 'utf8');
  return record;
}

// Scripts list a depot first and the app last; take the first candidate appdetails recognises.
async function resolve_display(candidates) {
  for (const id of candidates) {
    const hit = await app_lookup(id);
    if (hit) return hit;
  }
  return null;
}

function local_manifest(depot) {
  const dir = paths.depotcache();
  if (!paths.exists(dir)) return null;
  let best = null;
  for (const name of fs.readdirSync(dir)) {
    const m = /^(\d+)_(\d+)\.manifest$/i.exec(name);
    if (!m || m[1] !== String(depot)) continue;
    if (!best || BigInt(m[2]) > BigInt(best)) best = m[2];
  }
  return best;
}

async function resolve_package(appid) {
  if (!is_appid(appid)) throw bad_appid();
  let info = null;
  let depots = [];
  const warnings = [];
  try {
    info = await fetch_info(appid);
    depots = windows_depots(info);
  } catch (err) {
    // A delisted or brand-new app can be missing from the SteamCMD mirror entirely; the service's
    // depot list still names the depots and their keys.
    warnings.push(`no SteamCMD appinfo (${err.message})`);
  }

  // The only place depot keys and access tokens come from. A failure here is not something to guess
  // around: without them a script is a stub that installs nothing, so the call is handed back.
  let pkg;
  try {
    pkg = await api.package_for(appid);
  } catch (err) {
    // Keep the service's own verdict: "no data for this id" and "the service is down" are different
    // things to the person clicking add, and they were both arriving as a 500 internal error.
    const wrapped = new Error(`the data service has no answer for ${appid} (${err.message})`);
    wrapped.code = err.code;
    wrapped.status = err.code === 'unknown_app' ? 404 : err.code === 'unreachable' ? 503 : err.status;
    throw wrapped;
  }

  if (!depots.length) {
    // The supplier's list leads with the app's own id, which is the app-level key, not a depot:
    // render() writes the app line itself, so that entry is dropped here.
    depots = pkg.depots
      .filter((d) => String(d.depot) !== String(appid))
      .map((d) => ({ ...d, shared_from: null, dlc: null, name: null, size: null }));
  }

  // SteamCMD knows the depots and their public manifests; the service knows the keys. Neither alone
  // writes a complete script, so they are joined per depot.
  const keys = new Map(pkg.depots.map((d) => [String(d.depot), d.key]).filter(([, key]) => key));
  const resolved = depots.map((d) => ({
    ...d,
    key: keys.get(String(d.depot)) || null,
    manifest: d.manifest || local_manifest(d.depot),
  }));

  const missing_keys = resolved.filter((d) => !d.key).length;
  const missing_manifests = resolved.filter((d) => !d.manifest).length;
  if (!resolved.length) warnings.push('no windows depots listed for this app');
  if (missing_keys) warnings.push(`${missing_keys} of ${resolved.length} depots have no key here`);
  if (missing_manifests) {
    warnings.push(missing_manifests === 1
      ? '1 depot has no public manifest; Steam uses the latest found on install'
      : `${missing_manifests} depots have no public manifest; Steam uses the latest found on install`);
  }

  // The service reports on its own depot list, which can be longer than the Windows list SteamCMD
  // gives us; only its "nothing at all" warning adds something the two counts above do not say.
  const extra_warnings = (pkg.warnings || []).filter((w) => /no depots are listed/.test(w));

  // The pre-flight verdict, computed over the list this script will actually write - the Windows
  // depots, joined with the service's keys. The gate is "at least one depot has a key", the same
  // line the service's addable count draws: a title with none installs nothing and is refused. A
  // title with some is writable but incomplete, so it stays addable and carries the count.
  const keyed = resolved.filter((d) => d.key).length;
  const renderable = resolved.length > 0 && keyed > 0;
  const partial = renderable && keyed < resolved.length;
  const reason = !resolved.length
    ? 'no depots are listed for this app, so a script would install nothing'
    : !keyed
      ? `none of the ${resolved.length} depots have a key here`
      : partial
        ? `${resolved.length - keyed} of ${resolved.length} depots have no key here`
        : null;

  return {
    appid: String(appid),
    name: info?.common?.name || pkg.name || `app ${appid}`,
    type: info?.common?.type || null,
    oslist: info?.config?.oslist || null,
    token: pkg.token || null,
    depots: resolved,
    warnings: [...warnings, ...extra_warnings],
    renderable,
    partial,
    reason,
    // What the service has seen on other machines, when anybody has told it.
    report: pkg.report || null,
    source: info ? `api.steamcmd.net + service (${pkg.source})` : `service (${pkg.source})`,
  };
}

module.exports = {
  is_appid, search_store, resolve_package, app_name, app_lookup, app_details, resolve_display,
  removed_from_store,
};
