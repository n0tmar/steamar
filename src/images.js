'use strict';

// Disk-cached proxy for Steam artwork: the first request pulls from the CDN, later ones are a
// file read off localhost, so the grid stays off the network and works offline afterwards.
// It answers no HTTP itself; server.js calls it.
// Trap: art that produced nothing is remembered in memory as a miss until the engine restarts.

const fs = require('node:fs');
const path = require('node:path');
const paths = require('./paths');
const { site_url } = require('./device');

const CDN = 'https://cdn.cloudflare.steamstatic.com/steam/apps';
const SHARED = 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps';
const BG = 'https://store.akamai.steamstatic.com/images/storepagebackground/app';
const UA = 'SteaMar/0.3 (+local)';
const ART_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MIN_BYTES = 512;
const MAX_BYTES = 8 * 1024 * 1024; // art is a few hundred kilobytes
const MAX_HOPS = 3;

// kind -> classic cdn file name. `cap` is the small 231x87 capsule, a fallback in the fixes list.
const KINDS = {
  h: { file: 'header.jpg', type: 'image/jpeg' },
  cap: { file: 'capsule_231x87.jpg', type: 'image/jpeg' },
  hero: { file: 'library_hero.jpg', type: 'image/jpeg' },
  // The 600x900 cover Steam's own library shows, for the library's wall of covers.
  tall: { file: 'library_600x900.jpg', type: 'image/jpeg' },
};

const misses = new Set(); // appid:kind pairs that produced nothing, for this process only
const inflight = new Map(); // dedupes the same art being fetched by several rows at once

// When a title has no art at any expected path, reuse the header rather than show a hole.
const FALLBACK = { hero: 'h', cap: 'h', tall: 'h' };

function cache_file(kind, appid) {
  const dir = paths.ensure_dir(path.join(paths.out_dir(), 'imgcache', kind));
  return path.join(dir, `${appid}.jpg`);
}

function art_file(appid) {
  return path.join(paths.ensure_dir(path.join(paths.out_dir(), 'cache', 'art')), `${appid}.json`);
}

// Everything released recently ships its art under a hashed store_item_assets folder, so the
// stable /steam/apps/<id>/header.jpg path 404s outright. appdetails is the only place that
// reports the hashed URLs, so remember them per appid instead of asking again per image.
function art_read(appid) {
  try {
    const rec = JSON.parse(fs.readFileSync(art_file(appid), 'utf8'));
    if (Date.now() - (rec.fetched || 0) < ART_TTL_MS) return rec;
  } catch { /* no record yet */ }
  // catalog.app_lookup already caches header_image for ids the rest of the app has looked up.
  try {
    const rec = JSON.parse(fs.readFileSync(path.join(paths.out_dir(), 'cache', 'names', `${appid}.json`), 'utf8'));
    if (rec.image) return { fetched: Date.now(), h: rec.image, name: rec.name || null };
  } catch { /* nothing cached for this id */ }
  return null;
}

async function art_fetch(appid) {
  const url = `https://store.steampowered.com/api/appdetails?appids=${appid}&l=english`;
  let data = null;
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(12000) });
    const body = await res.json();
    data = body?.[appid]?.data || null;
  } catch { return null; } // network hiccup: caller just falls through to the classic paths

  const rec = data
    ? {
      fetched: Date.now(),
      name: data.name || null,
      h: data.header_image || null,
      cap: data.capsule_image || null,
      hero: data.background_raw || null,
    }
    : { fetched: Date.now(), missing: true };
  try {
    fs.writeFileSync(art_file(appid), JSON.stringify(rec), 'utf8');
  } catch { /* cache is best effort */ }
  return rec;
}

// Ordered candidate URLs. Classic stable paths first (no lookup needed, most games still have
// them), then the hashed assets appdetails knows about when a lookup has already happened.
function candidates(kind, appid, art) {
  const list = [];
  const push = (u) => { if (u && !list.includes(u)) list.push(u); };
  if (kind === 'h') {
    push(art?.h);
    push(`${CDN}/${appid}/${KINDS.h.file}`);
    push(`${SHARED}/${appid}/${KINDS.h.file}`);
  } else if (kind === 'cap') {
    push(art?.cap);
    push(`${CDN}/${appid}/${KINDS.cap.file}`);
    push(`${SHARED}/${appid}/${KINDS.cap.file}`);
  } else if (kind === 'tall') {
    push(`${CDN}/${appid}/${KINDS.tall.file}`);
    push(`${SHARED}/${appid}/${KINDS.tall.file}`);
  } else if (kind === 'hero') {
    push(`${CDN}/${appid}/${KINDS.hero.file}`);
    push(art?.hero);
    push(`${BG}/${appid}`);
  }
  return list;
}

// Steam mixes jpegs and webps behind the same .jpg names, so trust the bytes, not the header.
function sniff_type(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG') return 'image/png';
  if (buf.toString('ascii', 0, 3) === 'GIF') return 'image/gif';
  return null;
}

function sniff_file(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(16);
    const read = fs.readSync(fd, buf, 0, 16, 0);
    fs.closeSync(fd);
    return sniff_type(buf.subarray(0, read));
  } catch {
    return null;
  }
}

// One url, followed by hand so that every hop has to be https: a table row, or a mirror that redirects,
// must not get a plaintext request - or one to a machine on the local network - out of this app. An
// http:// address is tried as https:// first, because the few rows that name one are on hosts that do both.
async function open_https(url) {
  let target = String(url).replace(/^http:/i, 'https:');
  for (let hop = 0; hop <= MAX_HOPS; hop += 1) {
    let parsed;
    try { parsed = new URL(target); } catch { return null; }
    if (parsed.protocol !== 'https:') return null;
    const res = await fetch(parsed, { headers: { 'user-agent': UA }, redirect: 'manual', signal: AbortSignal.timeout(15000) });
    const next = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    if (!next) return res;
    if (res.body) res.body.cancel().catch(() => {});
    try { target = new URL(next, parsed).href; } catch { return null; }
  }
  return null;
}

// The body, unless it is bigger than any piece of art is: read as it arrives, so a host that never stops
// sending is cut off instead of held in memory.
async function read_capped(res) {
  if (Number(res.headers.get('content-length') || 0) > MAX_BYTES) return null;
  const chunks = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.length;
    if (size > MAX_BYTES) return null; // leaving the loop cancels the rest of the download
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

async function grab(url, file) {
  try {
    const res = await open_https(url);
    if (!res || !res.ok) return null;
    const header_type = res.headers.get('content-type') || '';
    if (header_type.startsWith('text/')) return null; // error pages come back as 200 text/html
    const bytes = await read_capped(res);
    if (!bytes || bytes.length < MIN_BYTES) return null;
    // The bytes decide: a host that labels a GIF application/octet-stream still sent a picture.
    const type = sniff_type(bytes) || (header_type.startsWith('image/') ? header_type : '');
    if (!type) return null;
    fs.writeFileSync(file + '.tmp', bytes);
    fs.renameSync(file + '.tmp', file);
    return type;
  } catch {
    return null;
  }
}

// Returns {file, type} when the bytes are on disk, else null. Never throws.
async function ensure(kind, appid) {
  const spec = KINDS[kind];
  if (!spec || !/^\d{1,12}$/.test(String(appid))) return null;
  const key = `${kind}:${appid}`;
  if (misses.has(key)) return null;

  const file = cache_file(kind, appid);
  if (paths.exists(file)) {
    // A half-written or error-page file from an older build counts as a miss, not a hit.
    try {
      if (fs.statSync(file).size >= MIN_BYTES) {
        return { file, type: sniff_file(file) || spec.type };
      }
      fs.unlinkSync(file);
    } catch { /* raced with another request */ }
  }

  const running = inflight.get(key);
  if (running) return running;

  const job = (async () => {
    let art = art_read(appid);
    let urls = candidates(kind, appid, art);
    const tried = new Set(urls);
    for (let round = 0; round < 2; round++) {
      for (const url of urls) {
        const type = await grab(url, file);
        if (type) return { file, type };
      }
      if (round === 0 && !art) {
        art = await art_fetch(appid);
        urls = candidates(kind, appid, art).filter((u) => !tried.has(u));
        urls.forEach((u) => tried.add(u));
        if (!urls.length) break;
      } else break;
    }

    const alt = FALLBACK[kind];
    if (alt) {
      const fb = await ensure(alt, appid);
      if (fb) {
        try {
          fs.copyFileSync(fb.file, file);
          return { file, type: fb.type || spec.type };
        } catch { /* fall through to a miss */ }
      }
    }
    misses.add(key);
    return null;
  })();

  inflight.set(key, job);
  try {
    return await job;
  } finally {
    inflight.delete(key);
  }
}

// Local URL for a game's art. The client uses these instead of CDN links.
const url = (appid) => `/img/${appid}.jpg`;
const hero = (appid) => `/img/hero/${appid}.jpg`;
const tall = (appid) => `/img/tall/${appid}.jpg`;

// The release's own poster on online-fix: the last resort, and the only art there is for the ids
// Steam will not resolve. Fetched once and cached like everything else, so the tab works offline.
async function poster_ensure(id, url) {
  if (!url || !/^\d{1,12}$/.test(String(id))) return null;
  const dir = paths.ensure_dir(path.join(paths.out_dir(), 'imgcache', 'of'));
  return fetch_once(`of:${id}`, path.join(dir, `${id}.jpg`), url);
}

// The page's own pictures: role badges, frames and profile pictures. They live on the site, and inside
// the window https://steamar.cc is the ui/ folder, so the page cannot load them from there. The engine
// fetches each once from the real site, keeps it, and serves it as /img/site/<rel>. Only these shapes
// are asked for, so the page cannot turn the engine into a fetcher of anything else.
const SITE_FILES = [
  [/^badges\/([\w.-]+\.(?:png|gif))$/i, (name) => `/assets/badges/${name}`],
  [/^frames\/([a-z0-9-]+\.gif)$/, (name) => `/assets/frames/${name}`],
  [/^profile\/([a-f0-9]{24}\.(?:jpg|png|webp))$/, (name) => `/v1/profile/image?f=${name}`],
];

async function site_ensure(rel) {
  for (const [shape, remote] of SITE_FILES) {
    const m = shape.exec(String(rel));
    if (!m) continue;
    const dir = paths.ensure_dir(path.join(paths.out_dir(), 'imgcache', 'site', rel.split('/')[0]));
    return fetch_once(`site:${rel}`, path.join(dir, m[1]), `${site_url()}${remote(m[1])}`);
  }
  return null;
}

// One file on disk per key, fetched at most once at a time; a miss is remembered for this process.
async function fetch_once(key, file, url) {
  if (misses.has(key)) return null;
  if (paths.exists(file)) {
    try {
      if (fs.statSync(file).size >= MIN_BYTES) return { file, type: sniff_file(file) || 'image/jpeg' };
      fs.unlinkSync(file);
    } catch { /* raced with another request */ }
  }

  const running = inflight.get(key);
  if (running) return running;

  const job = (async () => {
    const type = await grab(url, file);
    if (type) return { file, type };
    misses.add(key);
    return null;
  })();

  inflight.set(key, job);
  try {
    return await job;
  } finally {
    inflight.delete(key);
  }
}

// Banner slides need a real wide asset; asking first keeps 460px headers from being stretched.
// Real answers are kept on disk for a week: asking the CDN again at every start held Home's shelves
// for a second. A host that never answered says nothing about the art, so that is asked again.
const HERO_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const hero_seen = new Map();
let hero_disk = null;
const heroes_file = () => path.join(paths.ensure_dir(path.join(paths.out_dir(), 'cache', 'store')), 'heroes.json');

function hero_saved() {
  if (!hero_disk) {
    try { hero_disk = JSON.parse(fs.readFileSync(heroes_file(), 'utf8')) || {}; } catch { hero_disk = {}; }
  }
  return hero_disk;
}

function hero_keep(key, ok) {
  const now = Date.now();
  const saved = hero_saved();
  saved[key] = { ok, at: now };
  for (const [id, rec] of Object.entries(saved)) if (!(now - rec.at < HERO_KEEP_MS)) delete saved[id];
  try { fs.writeFileSync(heroes_file(), JSON.stringify(saved)); } catch { /* asked again next start */ }
}

async function hero_available(appid) {
  const key = String(appid);
  if (hero_seen.has(key)) return hero_seen.get(key);
  const saved = hero_saved()[key];
  if (saved && Date.now() - saved.at < HERO_KEEP_MS) return Boolean(saved.ok);
  // The two art hosts are alternatives, not steps: asking both at once costs one timeout instead of
  // two when neither answers, and a wide asset is used as soon as either says it has one.
  const probes = [`${CDN}/${appid}/${KINDS.hero.file}`, `${BG}/${appid}`];
  const answers = await Promise.all(probes.map(async (url) => {
    try {
      const res = await fetch(url, { method: 'HEAD', headers: { 'user-agent': UA }, signal: AbortSignal.timeout(8000) });
      return res.ok && (res.headers.get('content-type') || 'image/').startsWith('image/');
    } catch { return null; }
  }));
  const ok = answers.some(Boolean);
  hero_seen.set(key, ok);
  if (ok || !answers.includes(null)) hero_keep(key, ok);
  return ok;
}

function cache_stats() {
  const base = path.join(paths.out_dir(), 'imgcache');
  let files = 0;
  let bytes = 0;
  for (const kind of Object.keys(KINDS)) {
    const dir = path.join(base, kind);
    if (!paths.exists(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      files++;
      try { bytes += fs.statSync(path.join(dir, f)).size; } catch { /* file vanished */ }
    }
  }
  return { files, bytes };
}

module.exports = { ensure, poster_ensure, site_ensure, url, hero, tall, hero_available, cache_stats, KINDS };
