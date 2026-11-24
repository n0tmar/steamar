'use strict';

// Everything SteaMar needs but does not ship as code: the three helper files and the game list.
// A fresh copy downloads them itself into vendor/ and the data folder, so the folder stays portable:
// nothing is fetched from a link the user must find, and no absolute path is stored.
// Copying the files into Steam is setup.js. update.js reuses fetch_file and unpack.
// Trap: start() returns at once and the job runs in the background; poll progress().
// Downloads are https only: a redirect to http rejects the download.

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const { spawnSync } = require('node:child_process');
const paths = require('./paths');

const TOML = 'opensteamtool.toml';
const TIMEOUT_MS = 60000;
const AGENT = 'SteaMar/0.4 (+portable)';

/* ---------- where things live ---------- */

const vendor_dir = () => path.join(paths.project_root(), 'vendor');
const vendor_manifest = () => path.join(vendor_dir(), 'vendor.json');
const download_dir = () => paths.ensure_dir(path.join(paths.out_dir(), 'download'));
const data_archive = () => path.join(paths.data_dir('manifesthub3'), 'archive');

const dll_names = () => paths.config().proxy_dlls || [];
const sources = () => (paths.config().vendor && paths.config().vendor.sources) || [];
const data_urls = () => (paths.config().data_files && paths.config().data_files.urls) || {};

const present = (file) => paths.size_of(file) > 0;

// The game list is live data: new titles land upstream all the time, so a copy that sits on a
// stick for a month must be able to pull a newer one. config/steam.json can change the window.
const REFRESH_DAYS = Number((paths.config().data_files || {}).refresh_days) || 7;
const DAY_MS = 86400000;

function age_days(file) {
  try { return (Date.now() - fs.statSync(file).mtimeMs) / DAY_MS; } catch { return Infinity; }
}

function stale(name) {
  const file = path.join(data_archive(), name);
  return !present(file) || age_days(file) >= REFRESH_DAYS;
}

/* ---------- status ---------- */

function manifest() {
  try { return JSON.parse(fs.readFileSync(vendor_manifest(), 'utf8')); } catch { return null; }
}

// The helper files are only useful as a set: two of three is not a setup.
function helpers_ready() {
  const dir = vendor_dir();
  return dll_names().every((name) => present(path.join(dir, name))) && present(path.join(dir, TOML));
}

// The helper files run inside Steam, so each one must match a checksum that config/steam.json names
// for one of its sources. A release re-uploaded upstream, a mirror that serves something else, or a
// file somebody dropped into a folder is refused before it can reach Steam.
function is_known(name, file, from = sources()) {
  let sum;
  try { sum = paths.sha256(file); } catch { return false; }
  const key = String(name).toLowerCase();
  return from.some((source) => Object.entries(source.sha256 || {})
    .some(([pinned, value]) => pinned.toLowerCase() === key && String(value).toLowerCase() === sum));
}

// A copy can be interrupted (power cut, full disk, antivirus quarantine), and a truncated DLL looks
// present, so present is not enough: each file must still match its checksum.
function helpers_intact() {
  return helpers_ready() && dll_names().every((name) => is_known(name, path.join(vendor_dir(), name)));
}

function data_ready() {
  return Object.keys(data_urls()).every((name) => present(path.join(data_archive(), name)));
}

const data_stale = () => Object.keys(data_urls()).some(stale);

// A half-written JSON file is worse than a missing one: it parses to nonsense or throws on every
// request. Check what actually landed before calling the job done.
function data_sound() {
  for (const name of Object.keys(data_urls())) {
    const file = path.join(data_archive(), name);
    if (!present(file)) return false;
    if (!name.endsWith('.json')) continue;
    try { JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return false; }
  }
  return true;
}

function state() {
  const dir = vendor_dir();
  const saved = manifest();
  return {
    dir,
    ready: helpers_ready(),
    version: saved ? `${saved.name} ${saved.version}` : null,
    files: dll_names().map((name) => ({ name, present: present(path.join(dir, name)), bytes: paths.size_of(path.join(dir, name)) })),
    toml: present(path.join(dir, TOML)),
    data: {
      dir: data_archive(),
      // No urls means nothing to download: the tables are served. `ready` stays true so the setup
      // step does not wait for a file that will never arrive.
      source: Object.keys(data_urls()).length ? 'download' : 'service',
      ready: data_ready(),
      stale: data_stale(),
      refresh_days: REFRESH_DAYS,
      files: Object.keys(data_urls()).map((name) => ({ name, present: present(path.join(data_archive(), name)), bytes: paths.size_of(path.join(data_archive(), name)), stale: stale(name) })),
    },
    download: progress(),
  };
}

/* ---------- http ---------- */

// One file in, bytes on disk, redirects followed. GitHub answers a release asset with a 302 to
// objects.githubusercontent.com, so following them is not optional.
//
// https at every hop. A redirect to plain http would hand the bytes to anyone on the path, and
// https.get throws on it from inside a response callback, where nothing can catch it and the whole
// engine exits: so the address is checked first, and a bad one rejects the download instead.
function fetch_file(url, target, on_bytes) {
  return new Promise((resolve, reject) => {
    const on_response = (current, hops) => (res) => {
      const code = res.statusCode || 0;
      if (code >= 300 && code < 400 && res.headers.location) {
        res.resume();
        if (hops >= 6) return reject(new Error('too many redirects'));
        let next;
        try { next = new URL(res.headers.location, current).toString(); } catch { return reject(new Error('the redirect named an address that is not a URL')); }
        return go(next, hops + 1);
      }
      if (code !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${code} for ${path.basename(new URL(current).pathname)}`));
      }
      const total = Number(res.headers['content-length'] || 0);
      let got = 0;
      const out = fs.createWriteStream(target);
      res.on('data', (chunk) => {
        got += chunk.length;
        if (on_bytes) on_bytes(got, total);
      });
      res.on('error', reject);
      out.on('error', reject);
      out.on('finish', () => resolve({ bytes: got, total }));
      res.pipe(out);
    };

    const go = (current, hops) => {
      let request;
      try {
        const scheme = new URL(current).protocol;
        if (scheme !== 'https:') throw new Error(`refusing to download over ${scheme.replace(/:$/, '')}, only https`);
        request = https.get(current, { headers: { 'user-agent': AGENT } }, on_response(current, hops));
      } catch (err) {
        return reject(err);
      }
      request.setTimeout(TIMEOUT_MS, () => request.destroy(new Error('the download timed out')));
      request.on('error', reject);
    };

    go(url, 0);
  });
}

/* ---------- helpers ---------- */

// tar handles zip on Windows 11 and is already on PATH; Expand-Archive is the fallback for a
// stripped-down machine that removed it.
function unpack(zip, into) {
  fs.rmSync(into, { recursive: true, force: true });
  paths.ensure_dir(into);
  const tar = spawnSync('tar', ['-xf', zip, '-C', into], { windowsHide: true, encoding: 'utf8' });
  if (tar.status === 0) return;
  // The two paths go through the environment, not into the command: a folder called O'Brien ends a
  // single-quoted PowerShell string, and a curly quote in a name does the same without being doubled.
  const ps = spawnSync('powershell', ['-NoProfile', '-Command',
    'Expand-Archive -LiteralPath $env:STEAMAR_ZIP -DestinationPath $env:STEAMAR_INTO -Force'], {
    windowsHide: true,
    encoding: 'utf8',
    env: { ...process.env, STEAMAR_ZIP: zip, STEAMAR_INTO: into },
  });
  if (ps.status !== 0) throw new Error(`could not unpack ${path.basename(zip)}`);
}

function find_file(dir, name) {
  const lower = name.toLowerCase();
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const hit = find_file(full, name);
      if (hit) return hit;
    } else if (entry.name.toLowerCase() === lower) {
      return full;
    }
  }
  return null;
}

async function fetch_helpers() {
  const dir = vendor_dir();
  paths.ensure_dir(dir);
  const failures = [];
  for (const source of sources()) {
    const zip = path.join(download_dir(), `${source.name}-${source.version}.zip`);
    try {
      job.step = 'helpers';
      job.label = `helper files (${source.name} ${source.version})`;
      job.bytes = 0;
      job.total = 0;
      await fetch_file(source.url, zip, (got, total) => { job.bytes = got; job.total = total; });

      const unpacked = path.join(download_dir(), `unpack-${source.name}`);
      unpack(zip, unpacked);
      const found = {};
      for (const name of dll_names()) {
        const hit = find_file(unpacked, name);
        if (hit) found[name] = hit;
      }
      const missing = dll_names().filter((name) => !found[name]);
      if (missing.length) throw new Error(`the archive has no ${missing.join(', ')}`);
      const unknown = Object.keys(found).filter((name) => !is_known(name, found[name], [source]));
      if (unknown.length) throw new Error(`the archive's ${unknown.join(', ')} did not match the checksum SteaMar expects`);

      for (const [name, from] of Object.entries(found)) fs.copyFileSync(from, path.join(dir, name));
      fs.copyFileSync(path.join(paths.project_root(), 'tools', TOML), path.join(dir, TOML));

      fs.writeFileSync(vendor_manifest(), JSON.stringify({
        name: source.name,
        version: source.version,
        url: source.url,
        fetched: new Date().toISOString(),
        files: dll_names().map((name) => ({ name, sha256: paths.sha256(path.join(dir, name)), bytes: paths.size_of(path.join(dir, name)) })),
      }, null, 2), 'utf8');

      fs.rmSync(zip, { force: true });
      fs.rmSync(unpacked, { recursive: true, force: true });
      return `${source.name} ${source.version}`;
    } catch (err) {
      failures.push(`${source.name}: ${err.message}`);
      // Do not leave a half-downloaded archive on the stick.
      fs.rmSync(zip, { force: true });
      fs.rmSync(path.join(download_dir(), `unpack-${source.name}`), { recursive: true, force: true });
    }
  }
  throw new Error(`no helper files could be downloaded (${failures.join('; ')})`);
}

async function fetch_data(force = false) {
  const dir = paths.ensure_dir(data_archive());
  for (const [name, url] of Object.entries(data_urls())) {
    const target = path.join(dir, name);
    if (!force && present(target) && !stale(name)) continue;
    job.step = 'data';
    job.label = `game data (${name})`;
    job.bytes = 0;
    job.total = 0;
    const part = `${target}.part`;
    try {
      await fetch_file(url, part, (got, total) => { job.bytes = got; job.total = total; });
      if (!present(part)) throw new Error(`${name} came back empty`);
      if (name.endsWith('.json')) JSON.parse(fs.readFileSync(part, 'utf8'));
      fs.renameSync(part, target);
    } catch (err) {
      // Keep the old copy working when an update fails halfway.
      fs.rmSync(part, { force: true });
      throw new Error(`${name}: ${err.message}`);
    }
  }
}

/* ---------- one job, polled by the UI ---------- */

let job = null;

function progress() {
  return job || { active: false, step: '', label: '', bytes: 0, total: 0, error: '', done: [] };
}

// Starts (or joins) the one download job. The work runs in the background so the bridge never
// holds a request open for a 16 MB file; the UI polls /api/setup for progress.
function start(force = false) {
  if (job && job.active) return progress();
  job = { active: true, step: '', label: 'starting', bytes: 0, total: 0, error: '', done: [] };
  (async () => {
    try {
      // A copy that already has everything only checks, so pressing the button again is cheap.
      if (!force && helpers_intact()) job.done.push('helpers');
      else job.done.push(`helpers (${await fetch_helpers()})`);

      if (!force && data_ready() && !data_stale() && data_sound()) {
        job.done.push('data');
      } else {
        const before = Object.keys(data_urls()).filter((name) => present(path.join(data_archive(), name)));
        await fetch_data(true);
        job.done.push(before.length ? 'data (updated)' : 'data');
      }

      if (!data_sound()) throw new Error('the game list came back unreadable; try again');

      job.step = 'done';
      job.label = 'everything SteaMar needs is here';
    } catch (err) {
      job.error = err.message;
      job.step = 'failed';
      job.label = err.message;
    } finally {
      job.active = false;
      job.bytes = 0;
      job.total = 0;
    }
  })();
  return progress();
}

module.exports = {
  state, start, progress, data_stale, stale, vendor_dir, fetch_helpers, is_known, TOML,
  // The update download is the same job as the helper fetch: one file, a checksum, an unpack. Two
  // copies of that code would be two places for the redirect rule and the tar fallback to rot.
  fetch_file, unpack,
};
