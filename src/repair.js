'use strict';

// inspect() finds what breaks the Steam side (foreign DLLs, a stale TOML, bad scripts) and fix()
// repairs it. It deletes nothing: files in the way are moved to a quarantine folder under out/.
// Trap: fix() refuses while Steam runs unless options.allow_running is set, which only the test
// harness passes.

// A checkup for the Steam side of the app. Every report of "it works for you and not for me" is
// one of a few things: files missing, files from an older or different tool setup, a config that
// no longer matches its payloads, or scripts that do not parse. This module finds them and puts
// the folder back to the state SteaMar ships and tests.
//
// Nothing is ever deleted: a file that is in the way is moved to out/quarantine/<time>/, so the
// person can look at it, or put it back.

const fs = require('node:fs');
const path = require('node:path');
const paths = require('./paths');
const vendor = require('./vendor');
const library = require('./library');

const TOML = 'opensteamtool.toml';
const SECTIONS = ['[log]', '[manifest]', '[inject]'];

// Loaders, and loaders' leftovers, that other tools drop beside steam.exe. Two proxy DLLs in one
// folder is the most common reason a game loads for one person and not for another: Windows picks
// the first one it finds, and it may not be the one that works.
const FOREIGN = [
  'version.dll',
  'winmm.dll',
  'd3d9.dll',
  'dxgi.dll',
  'dinput8.dll',
  'msimg32.dll',
  'opengl32.dll',
  'uxtheme.dll',
  'xinput9_1_0.dll',
  'xinput1_3.dll',
  'steam_api.dll',
  'steam_api64.dll',
  'cream_api.ini',
  'smartsteamemu.ini',
  'goldberg.ini',
  'ColdClientLoader.ini',
];

const STALE_SUFFIXES = ['.bak', '.old', '.orig', '.disabled', '.backup'];

const readable = (file) => {
  try { fs.accessSync(file, fs.constants.R_OK); return true; } catch { return false; }
};
const lower = (name) => String(name).toLowerCase();

/* ---------- reading the opensteamtool.toml ---------- */

// Enough TOML to answer the only question that matters: does this config point at payloads that
// are still there? A row pointing at a missing DLL is a broken setup, whoever wrote it.
function inject_rows(body) {
  const rows = [];
  let current = null;
  for (const line of body.split(/\r?\n/)) {
    const text = line.trim();
    if (text === '[[inject]]') {
      current = { path: '', all_games: false };
      rows.push(current);
      continue;
    }
    if (text.startsWith('[')) {
      current = null;
      continue;
    }
    if (!current) continue;
    const quoted = text.match(/^path\s*=\s*"((?:[^"\\]|\\.)*)"/);
    if (quoted) current.path = quoted[1].replace(/\\\\/g, '\\');
    if (/^all_games\s*=\s*true/.test(text)) current.all_games = true;
  }
  return rows;
}

/* ---------- where things are ---------- */

const root = () => paths.steam_root();
const vendor_file = (name) => path.join(vendor.vendor_dir(), name);

/* ---------- inspect ---------- */

// One pass over everything that can be wrong, in the order a person would look at it.
// severity: blocker (cannot fix yet), fix (SteaMar can put this right), warn (their call), info.
function inspect() {
  const findings = [];
  const add = (finding) => findings.push({ severity: 'warn', fixable: false, action: 'none', ...finding });
  const steam = root();
  const helpers = paths.config().proxy_dlls || [];
  const ours = new Set(helpers.map(lower));

  /* Steam itself */
  const steam_here = paths.exists(path.join(steam, 'steam.exe'));
  if (!steam_here) {
    add({
      id: 'steam-missing',
      severity: 'blocker',
      action: 'choose',
      title: 'Steam is not in that folder',
      detail: `no steam.exe in ${steam}. point SteaMar at the folder Steam is installed in`,
    });
  } else {
    if (!paths.exists(path.join(steam, 'steamapps'))) {
      add({
        id: 'steam-steamapps',
        severity: 'info',
        action: 'none',
        title: 'Steam has no steamapps folder yet',
        detail: 'Steam creates it the first time it runs',
      });
    }
    const vdf = path.join(steam, 'steamapps', 'libraryfolders.vdf');
    if (paths.exists(vdf)) {
      let body = '';
      try { body = fs.readFileSync(vdf, 'utf8'); } catch { /* unreadable */ }
      if (!/"?libraryfolders"?/i.test(body)) {
        add({
          id: 'steam-libraryfolders',
          severity: 'warn',
          action: 'none',
          title: 'Steam’s library list looks damaged',
          detail: 'libraryfolders.vdf does not look like a library list; Steam rebuilds it on the next start',
        });
      }
    }
  }

  /* the helper files SteaMar installs */
  for (const name of helpers) {
    const want = vendor_file(name);
    const have = path.join(steam, name);
    if (!readable(want)) {
      add({
        id: `helper-source:${name}`,
        severity: 'blocker',
        action: 'download',
        title: `SteaMar is missing its own copy of ${name}`,
        detail: 'the helper files have to be downloaded again before anything can be repaired',
      });
      continue;
    }
    if (!paths.exists(have)) {
      add({
        id: `dll-missing:${name}`,
        severity: 'fix',
        fixable: true,
        kind: 'dll',
        name,
        action: 'fix',
        title: `${name} is not in your Steam folder`,
        detail: 'SteaMar installs its own copy, which is the one this build is tested with',
      });
      continue;
    }
    let same = false;
    try { same = paths.sha256(have) === paths.sha256(want); } catch { same = false; }
    if (!same) {
      // A different size says "another build". The same size with a different hash says the same
      // thing without the confusing "109,568 bytes instead of 109,568".
      const mine = paths.size_of(want);
      const theirs = paths.size_of(have);
      add({
        id: `dll-stale:${name}`,
        severity: 'fix',
        fixable: true,
        kind: 'dll',
        name,
        action: 'fix',
        title: `${name} is not the build SteaMar ships`,
        detail: theirs === mine
          ? 'same size, different file. an older build, another tool’s copy, or a damaged one'
          : `${theirs.toLocaleString()} bytes instead of ${mine.toLocaleString()}. an older build, another tool’s copy, or a damaged one`,
      });
    }
  }

  /* the config */
  const toml = paths.toml_path();
  const toml_want = vendor_file(TOML);
  if (!paths.exists(toml)) {
    add({
      id: 'toml-missing',
      severity: 'fix',
      fixable: true,
      kind: 'toml',
      action: 'fix',
      title: 'opensteamtool.toml is missing',
      detail: 'without it the helper files do not know what to load',
    });
  } else {
    let body = '';
    try { body = fs.readFileSync(toml, 'utf8'); } catch { /* unreadable */ }
    const missing = SECTIONS.filter((section) => !body.includes(section));
    const rows = inject_rows(body);
    const dead = rows.filter((row) => row.path && !paths.exists(row.path));
    if (missing.length) {
      add({
        id: 'toml-sections',
        severity: 'fix',
        fixable: true,
        kind: 'toml',
        action: 'fix',
        title: 'opensteamtool.toml is incomplete',
        detail: `missing ${missing.join(', ')}. every build of the helper files expects the same three sections`,
      });
    } else if (dead.length) {
      add({
        id: 'toml-dead-inject',
        severity: 'fix',
        fixable: true,
        kind: 'toml',
        action: 'fix',
        title: `${dead.length} config row${dead.length === 1 ? '' : 's'} point at files that are gone`,
        detail: dead.map((row) => path.basename(row.path)).join(', ') + '. SteaMar writes its own default config and keeps yours beside it',
      });
    }
    if (rows.some((row) => row.all_games)) {
      add({
        id: 'toml-all-games',
        severity: 'warn',
        action: 'none',
        title: 'the config injects into every game',
        detail: 'all_games = true loads your payload for every title; that is how one game breaks all of them',
      });
    }
  }

  /* anything else that loads into Steam */
  for (const name of FOREIGN) {
    if (ours.has(lower(name))) continue;
    const file = path.join(steam, name);
    if (!paths.exists(file)) continue;
    add({
      id: `foreign:${name}`,
      severity: 'fix',
      fixable: true,
      kind: 'foreign',
      name,
      action: 'fix',
      title: `${name} from another tool is in your Steam folder`,
      detail: 'two loaders in one folder fight over the same games, so it moves to out/quarantine, not the bin',
    });
  }

  /* old copies of our own files, left behind by a half-finished setup */
  const stale = [];
  for (const name of helpers) {
    for (const suffix of STALE_SUFFIXES) {
      const file = path.join(steam, name + suffix);
      if (paths.exists(file)) stale.push(path.basename(file));
    }
  }
  if (stale.length) {
    add({
      id: 'stale-copies',
      severity: 'info',
      action: 'none',
      title: `${stale.length} old cop${stale.length === 1 ? 'y' : 'ies'} left in your Steam folder`,
      detail: `${stale.join(', ')}. harmless, Windows never loads them`,
    });
  }

  /* the scripts this app wrote */
  let scripts = [];
  try { scripts = library.scripts(); } catch { /* unreadable folder */ }
  const broken = scripts.filter((script) => !script.valid);
  if (broken.length) {
    add({
      id: 'scripts-broken',
      severity: 'fix',
      fixable: true,
      kind: 'scripts',
      files: broken.map((script) => script.file),
      action: 'fix',
      title: `${broken.length} added game${broken.length === 1 ? '' : 's'} cannot be read`,
      detail: `${broken.map((script) => script.file).join(', ')}. moved to quarantine, so add the game again for a clean copy`,
    });
  }
  const keyless = scripts.filter((script) => script.valid && script.kind === 'game' && script.keys === 0);
  if (keyless.length) {
    const one = keyless.length === 1;
    add({
      id: 'scripts-nokey',
      severity: 'warn',
      action: 'none',
      title: `${keyless.length} game${one ? ' has' : 's have'} no depot key`,
      detail: one
        ? `${keyless[0].file} was filled without one, so Steam will refuse to install it. remove it and add the game again`
        : 'they were added without a key, so Steam will refuse to install them. remove and add again',
    });
  }

  /* the two folders the app writes into */
  const folders = [
    ['stplug_in', 'Lua', paths.stplug_in()],
    ['depotcache', 'Manifest', paths.depotcache()],
  ];
  for (const [key, label, dir] of folders) {
    if (paths.exists(dir)) continue;
    add({
      id: `folder:${key}`,
      severity: 'fix',
      fixable: true,
      kind: 'folder',
      dir,
      action: 'fix',
      title: `the ${label} folder is missing`,
      detail: `${dir}. SteaMar creates it again`,
    });
  }

  /* the game list the app works from */
  const vendored = vendor.state();
  if (!vendored.data || !vendored.data.ready) {
    add({
      id: 'data-missing',
      severity: 'fix',
      fixable: true,
      kind: 'data',
      action: 'download',
      title: 'the game list is missing',
      detail: 'one download brings it back; nothing else needs to change',
    });
  }

  if (findings.some((f) => f.fixable) && paths.steam_running(true)) {
    add({
      id: 'steam-running',
      severity: 'blocker',
      action: 'close-steam',
      title: 'Steam is running',
      detail: 'close Steam, then repair. Steam holds those files open',
    });
  }

  const order = { blocker: 0, fix: 1, warn: 2, info: 3 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);

  const fixable = findings.filter((f) => f.fixable).length;
  const blockers = findings.filter((f) => f.severity === 'blocker').length;
  const warnings = findings.filter((f) => f.severity === 'warn').length;
  return {
    steam_root: steam,
    steam_running: paths.steam_running(),
    findings,
    summary: {
      state: blockers ? 'blocked' : fixable ? 'repair' : 'ok',
      fixable,
      blockers,
      warnings,
      checked_at: new Date().toISOString(),
    },
  };
}

/* ---------- fix ---------- */

// A file in the way is moved, not deleted: the same folder is unreachable from the app, but the
// person still has it if it turns out they wanted it.
function quarantine(file, tag) {
  const stamp = new Date().toISOString().replace(/[:]/g, '-').slice(0, 19);
  const dir = paths.ensure_dir(path.join(paths.out_dir(), 'quarantine', stamp));
  let target = path.join(dir, path.basename(file));
  let n = 2;
  while (paths.exists(target)) {
    target = path.join(dir, `${path.basename(file)}.${n}`);
    n += 1;
  }
  try {
    fs.renameSync(file, target);
  } catch {
    // Different drive: copy then remove, so a Steam folder on D: still works.
    fs.copyFileSync(file, target);
    fs.unlinkSync(file);
  }
  return `${tag ? `${tag}: ` : ''}${target}`;
}

// One finding, one action. Returns what happened so the person is told, not reassured.
function apply(finding) {
  const steam = root();
  if (finding.kind === 'dll') {
    const from = vendor_file(finding.name);
    const to = path.join(steam, finding.name);
    const moved = paths.exists(to) ? quarantine(to, 'old copy') : null;
    fs.copyFileSync(from, to);
    if (paths.size_of(to) !== paths.size_of(from)) throw new Error(`${finding.name} did not copy completely`);
    return { id: finding.id, title: finding.title, detail: `${finding.name} installed${moved ? ', old copy quarantined' : ''}`, moved: moved ? [moved] : [] };
  }
  if (finding.kind === 'toml') {
    const to = paths.toml_path();
    const from = paths.exists(vendor_file(TOML)) ? vendor_file(TOML) : path.join(paths.project_root(), 'tools', TOML);
    const moved = paths.exists(to) ? quarantine(to, 'previous config') : null;
    fs.copyFileSync(from, to);
    return { id: finding.id, title: finding.title, detail: 'default config written', moved: moved ? [moved] : [] };
  }
  if (finding.kind === 'foreign') {
    const moved = quarantine(path.join(steam, finding.name), 'other tool');
    return { id: finding.id, title: finding.title, detail: `${finding.name} moved aside`, moved: [moved] };
  }
  if (finding.kind === 'scripts') {
    const moved = finding.files.map((file) => quarantine(path.join(paths.stplug_in(), file), 'unreadable script'));
    return { id: finding.id, title: finding.title, detail: `${finding.files.length} script${finding.files.length === 1 ? '' : 's'} moved to quarantine`, moved };
  }
  if (finding.kind === 'folder') {
    paths.ensure_dir(finding.dir);
    return { id: finding.id, title: finding.title, detail: `${finding.dir} created`, moved: [] };
  }
  if (finding.kind === 'data') {
    vendor.start(true);
    return { id: finding.id, title: finding.title, detail: 'game list download started', moved: [] };
  }
  throw new Error(`nothing to do for ${finding.id}`);
}

// `only` is a list of finding ids: the UI can fix one row or everything. allow_running exists for
// the test harness, which points STEAM_ROOT at a folder that is not really Steam.
function fix(only = null, options = {}) {
  const report = inspect();
  if (!options.allow_running && paths.steam_running(true)) throw new Error('close Steam first, then repair');
  const wanted = Array.isArray(only) && only.length ? new Set(only) : null;
  const fixed = [];
  const failed = [];
  for (const finding of report.findings) {
    if (!finding.fixable) continue;
    if (wanted && !wanted.has(finding.id)) continue;
    try {
      fixed.push(apply(finding));
    } catch (err) {
      failed.push({ id: finding.id, title: finding.title, error: err.message });
    }
  }
  return { fixed, failed, state: inspect() };
}

module.exports = { inspect, fix, TOML };
