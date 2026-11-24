'use strict';

// The engine's read answers: each function builds the reply one screen asks for (status, settings,
// library, reach, self-test, names) from several modules, plus the data-repo pull Settings offers.
// It decides nothing and writes nothing except that pull; the modules it quotes own the facts.
// Trap: counts come from the service mirror in api.js, never from files here, and may be stale.

const fs = require('node:fs');
const path = require('node:path');
const paths = require('./paths');
const api = require('./api');
const catalog = require('./catalog');
const library = require('./library');
const images = require('./images');
const denuvo = require('./denuvo');
const onlinefix = require('./onlinefix');
const git = require('./git');

const PORT = paths.engine_port();

// How many titles this copy can add. The count is kept by the service, which is the only thing that
// can see every title and every key; the app quotes it and never derives it from a file.
async function reach() {
  // Ask the service first, within the mirror's own lifetime: without this the route only ever read
  // the cache, so the number could sit at whatever boot wrote until the window was restarted. A
  // mirror on disk is what answers when the call fails, which is the whole point of keeping one.
  try {
    await api.reach();
  } catch { /* the mirror below is the fallback, and say so in `mode` */ }

  const counts = api.counters();
  const service = api.state();
  // The numbers outlive a service that has stopped answering: they are the last good answer, kept in
  // the mirror. Reporting "service" then would be the app quoting a live figure it does not have, so
  // a stale mirror says so and carries the age it already has in measured_at.
  const mode = !counts.fetched ? 'none' : (service.last_error || !service.last_ok ? 'cache' : 'service');
  return {
    games_total: counts.addable,
    measured: counts.addable,
    indexed: counts.titles,
    indexed_measured: counts.titles,
    mode,
    stale: mode === 'cache',
    measured_at: counts.fetched ? new Date(counts.fetched).toISOString() : null,
    tokens: counts.tokens,
    depot_keys: counts.depot_keys,
    // How many titles the service has been told are failing somewhere. Zero is the normal day.
    failing: counts.failing,
    // The worst few by name, so the number can be read as titles rather than as a statistic.
    failing_titles: api.failing_titles(5),
  };
}

function dir_stats(dir) {
  if (!paths.exists(dir)) return { files: 0, bytes: 0 };
  let files = 0;
  let bytes = 0;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(current, e.name);
      if (e.isDirectory()) stack.push(full);
      else {
        files++;
        try { bytes += fs.statSync(full).size; } catch { /* unreadable */ }
      }
    }
  }
  return { files, bytes };
}

function git_head(dir) {
  if (!paths.exists(path.join(dir, '.git'))) return null;
  return git.head(dir);
}

// Minimal TOML reader for the [[inject]] array: flat scalars and inline string arrays only.
function parse_injection(text) {
  const out = [];
  let current = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)#.*$/, '').trim();
    if (!line) continue;
    if (line === '[[inject]]') { current = {}; out.push(current); continue; }
    if (line.startsWith('[')) { current = null; continue; }
    if (!current) continue;
    const m = /^([A-Za-z_][\w-]*)\s*=\s*(.+)$/.exec(line);
    if (!m) continue;
    const [, key, raw_value] = m;
    const value = raw_value.trim();
    if (value.startsWith('[')) {
      current[key] = value.replace(/[[\]]/g, '').split(',').map((s) => s.trim().replace(/^"|"$/g, '')).filter(Boolean);
    } else {
      current[key] = value.replace(/^"|"$/g, '');
    }
  }
  return out;
}

function settings_view() {
  const root = paths.steam_root();
  const toml_file = paths.toml_path();
  const toml_text = paths.exists(toml_file) ? fs.readFileSync(toml_file, 'utf8') : null;
  const injects = toml_text ? parse_injection(toml_text) : [];
  const cache = dir_stats(path.join(paths.out_dir(), 'cache'));
  const backups_dir = path.join(paths.out_dir(), 'backup');
  const backups = paths.exists(backups_dir)
    ? fs.readdirSync(backups_dir).filter((f) => f.endsWith('.lua')).map((f) => {
      const st = fs.statSync(path.join(backups_dir, f));
      return { file: f, bytes: st.size, time: st.mtimeMs };
    }).sort((a, b) => b.time - a.time)
    : [];

  return {
    app: {
      version: require('../package.json').version,
      node: process.version,
      port: PORT,
      // The update channel, as the service last answered it. The native shell answers /api/status
      // with its own shape, so this page cannot read it from there: the verdict is carried here.
      update: api.state().update,
      account: api.state().account,
    },
    steam: {
      root,
      source: process.env.STEAM_ROOT ? 'env' : 'config',
      running: paths.steam_running(),
      dlls: paths.proxy_dlls().map((d) => ({
        name: d.name,
        present: d.present,
        bytes: d.present ? fs.statSync(d.path).size : 0,
      })),
      toml: {
        present: Boolean(toml_text),
        sections: toml_text ? ['log', 'manifest', 'lua', 'inject', 'update', 'cloud'].filter((s) => new RegExp(`^\\[${s}\\]`, 'm').test(toml_text)) : [],
        injects,
      },
      paths: {
        stplug_in: paths.stplug_in(),
        depotcache: paths.depotcache(),
        steamapps: paths.steamapps(),
        auto: {
          stplug_in: !paths.is_override('stplug_in'),
          depotcache: !paths.is_override('depotcache'),
        },
        detected_root: paths.detect_steam_root(),
        dll_source: paths.dll_source(),
      },
    },
    data: {
      // Where the titles, keys and tokens come from: one service, one device, no files here.
      api: api.state(),
    },
    storage: { cache, backups: backups.slice(0, 20), backup_count: backups.length, imgcache: images.cache_stats() },
    // What limits a title: depot keys for the install, a token only when Steam will not authorize
    // the app anonymously. The sidebar quotes the token count on purpose - see README.
    coverage: {
      tokens: api.counters().tokens,
      depot_keys: api.counters().depot_keys,
      supplier_apps: api.counters().titles,
    },
    denuvo: denuvo.stats(),
    project: { root: paths.project_root(), out: paths.out_dir() },
  };
}

async function pull_repos() {
  const results = [];
  for (const [key, dir] of Object.entries({ manifesthub3: paths.data_dir('manifesthub3'), manifesthub: paths.data_dir('manifesthub') })) {
    if (!paths.exists(path.join(dir, '.git'))) { results.push({ repo: key, ok: false, reason: 'not cloned' }); continue; }
    const before = git_head(dir);
    const output = await git.pull(dir);
    results.push({ repo: key, ...output, before, after: git_head(dir) });
  }
  return { results };
}

// One press in Settings: the same handful of facts the doctor prints, in plain words, without a
// terminal. Nothing here touches the network, so it answers in milliseconds even offline.
function selftest() {
  const checks = [];
  const add = (id, ok, title, detail) => checks.push({ id, ok: Boolean(ok), title, detail: String(detail || '') });

  const root = paths.steam_root();
  add('steam', paths.exists(path.join(root, 'steam.exe')), 'Steam is installed', root);

  const dlls = paths.proxy_dlls();
  const have = dlls.filter((d) => d.present).length;
  add('helper', have === dlls.length, 'Helper files are in the Steam folder', `${have} of ${dlls.length} found`);

  const plug = paths.stplug_in();
  let writable = false;
  try {
    const probe = path.join(plug, '.steamar-write-test');
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    writable = true;
  } catch { writable = false; }
  const script_count = paths.exists(plug) ? fs.readdirSync(plug).filter((f) => /\.lua$/i.test(f)).length : 0;
  add('lua', writable, 'Games can be added', writable
    ? `${script_count} ${script_count === 1 ? 'game' : 'games'} added`
    : `SteaMar can't write to Steam's game folder (${plug})`);

  // The person reads this dialog, so it says what is wrong in their words; the codes stay in the log.
  const counts = api.counters();
  const service = api.state();
  add('service', service.enrolled && counts.addable > 0, 'SteaMar is connected',
    service.last_error ? "Can't connect right now. Check your internet connection."
      : service.enrolled ? `${counts.addable.toLocaleString()} games available` : 'This PC is not signed in yet');

  const fixes = onlinefix.load();
  add('fixes', fixes.items.length > 0, 'The fixes list is loaded', fixes.error
    ? "The fixes list couldn't be read. It loads again when you open Fixes."
    : `${fixes.items.length.toLocaleString()} fixes`);

  return { ok: checks.every((c) => c.ok), checks, when: new Date().toISOString() };
}

async function status() {
  const scripts = library.scripts();
  return {
    // Which copy of the app this engine belongs to. The shell compares it before reusing a
    // running engine, so a second copy never installs into the first copy's folders.
    root: paths.project_root(),
    steam_root: paths.steam_root(),
    steam_running: paths.steam_running(),
    proxy_dlls: paths.proxy_dlls().map((d) => ({ name: d.name, present: d.present })),
    toml: paths.exists(paths.toml_path()),
    scripts: scripts.filter((s) => s.kind === 'game').length,
    config_scripts: scripts.filter((s) => s.kind === 'config').length,
    // `available` keeps its old meaning for the empty-shelf check; the two counts beside it are
    // what actually limits a title: keys for its depots, and a token only when Steam will not
    // authorize the app anonymously (delisted / region-locked). Both come from the service.
    available: api.counters().tokens,
    tokens: api.counters().tokens,
    depot_keys: api.counters().depot_keys,
    needs_repair: scripts.filter((s) => !s.valid).length,
  };
}

async function names(ids) {
  const out = {};
  for (const id of ids.slice(0, 40)) {
    if (!catalog.is_appid(id)) continue;
    try { out[id] = await catalog.app_name(id); }
    catch { out[id] = { appid: id, name: `app ${id}`, image: null }; }
  }
  return out;
}

// Library rows carry resolved name and art, so the grid never falls back to a bare app id.
async function library_view() {
  const started = Date.now();
  const games = library.scripts();
  const out = [];
  for (const g of games) {
    const shown = g.kind === 'game' ? await catalog.resolve_display(g.candidates) : null;
    out.push({
      ...g,
      appid: shown?.appid || g.file_appid,
      name: shown?.name || null,
      image: shown ? images.url(shown.appid) : null,
      tall: shown ? images.tall(shown.appid) : null,
      resolved: Boolean(shown),
      denuvo: denuvo.has(shown?.appid || g.file_appid, shown?.name),
    });
  }
  // The website's copy of this shelf is only as good as this moment: send it when it has changed.
  // The promise is dropped on purpose - a page must not wait for the service to know what it already
  // drew.
  api.library_sync(out.filter((g) => g.kind === 'game').map((g) => ({ appid: g.appid, mtime: g.mtime })))
    .catch(() => null);
  return { games: out, ms: Date.now() - started };
}

module.exports = { reach, settings_view, pull_repos, selftest, status, names, library_view };
