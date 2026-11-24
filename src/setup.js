'use strict';

// First-run helper: find the proxy files, copy them into Steam, or take them back out again.
// It does not download them; vendor.js does, and this copies from the best folder it finds.
// Trap: install() and remove() throw while Steam runs, and remove() takes only the proxy files
// and opensteamtool.toml; added games stay.

const fs = require('node:fs');
const path = require('node:path');
const paths = require('./paths');
const vendor = require('./vendor');

const names = () => (paths.config().proxy_dlls || []);
const TOML = 'opensteamtool.toml';

// Folders worth looking in, in order: what the user picked, a vendor folder beside the app,
// then Steam itself (a re-setup after a client update may only need the folders created).
function candidates() {
  const configured = paths.config().dll_source;
  const list = [configured, path.join(paths.project_root(), 'vendor'), path.join(paths.project_root(), 'tools', 'dll'), paths.steam_root()];
  return [...new Set(list.filter(Boolean))];
}

// What a folder can actually offer: files among the proxy names, plus a TOML if it has one.
function describe(dir) {
  if (!dir || !paths.exists(dir)) return { dir: dir || null, exists: false, files: [], toml: false };
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch { /* unreadable folder */ }
  const lower = new Map(entries.map((n) => [n.toLowerCase(), n]));
  const files = [];
  for (const name of names()) {
    const real = lower.get(name.toLowerCase());
    if (!real) continue;
    const full = path.join(dir, real);
    let bytes = 0;
    try { bytes = fs.statSync(full).size; } catch { /* skip */ }
    files.push({ name: real, bytes });
  }
  return { dir, exists: true, files, toml: lower.has(TOML) };
}

function best_source() {
  for (const dir of candidates()) {
    const info = describe(dir);
    if (info.files.length) return info;
  }
  return describe(candidates()[0]);
}

function dll_state() {
  return names().map((name) => {
    const target = path.join(paths.steam_root(), name);
    const present = paths.exists(target);
    let bytes = 0;
    if (present) { try { bytes = fs.statSync(target).size; } catch { /* locked or gone */ } }
    return { name, present, bytes };
  });
}

function folder_state() {
  const detected = paths.detect_steam_root();
  const same = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();
  return [
    { key: 'steam_root', label: 'Steam folder', path: paths.steam_root(), exists: paths.exists(path.join(paths.steam_root(), 'steam.exe')), auto: same(paths.steam_root(), detected) },
    { key: 'stplug_in', label: 'Lua folder', path: paths.stplug_in(), exists: paths.exists(paths.stplug_in()), auto: !paths.is_override('stplug_in') },
    { key: 'depotcache', label: 'Manifest folder', path: paths.depotcache(), exists: paths.exists(paths.depotcache()), auto: !paths.is_override('depotcache') },
  ];
}

function state() {
  const dlls = dll_state();
  const toml = paths.exists(paths.toml_path());
  const source = best_source();
  const folders = folder_state();
  const local = vendor.state();
  return {
    ready: dlls.every((d) => d.present) && toml,
    steam_root: paths.steam_root(),
    detected_root: paths.detect_steam_root(),
    steam_running: paths.steam_running(),
    dlls,
    toml,
    source,
    folders,
    // The app's own copy, downloaded from config/steam.json. The UI installs from here by default.
    vendor: local,
    // True while the files the app needs are not on this machine yet, so the UI offers "download"
    // instead of a folder picker.
    needs_files: !source.files.length,
    can_install: source.files.length > 0,
  };
}

// A copy that fails halfway leaves Steam unfixable-looking: report what actually happened, and
// say what the person can do about it instead of showing a raw EPERM.
function explain(err, target) {
  const code = err && err.code;
  if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') {
    if (paths.steam_running(true)) return new Error('Steam is running and holding those files. close Steam, then press set up again');
    return new Error(`Windows would not let SteaMar write to ${target}. Run SteaMar as administrator and try again`);
  }
  if (code === 'ENOSPC') return new Error('there is no room left on that drive for the helper files');
  return err;
}

function install(folder) {
  const source = folder ? describe(folder) : best_source();
  if (!source.exists) throw new Error(`that folder does not exist: ${source.dir}`);
  if (!source.files.length) {
    throw new Error(folder
      ? `no ${names().join(' / ')} in ${folder}`
      : 'download the helper files first, then set up');
  }
  const unknown = source.files.filter((file) => !vendor.is_known(file.name, path.join(source.dir, file.name)));
  if (unknown.length) {
    const list = unknown.map((file) => file.name).join(', ');
    throw new Error(`${list} in ${source.dir} ${unknown.length === 1 ? 'is not a version' : 'are not versions'} SteaMar has checked. Download the helper files instead`);
  }
  if (paths.steam_running(true)) throw new Error('close Steam first, then set up again');

  // Adding files to a folder with no Steam in it is how a copy ends up "set up" somewhere that
  // does nothing. The Steam folder is the one with steam.exe in it.
  const root = paths.steam_root();
  if (!paths.exists(path.join(root, 'steam.exe'))) {
    throw new Error(`no steam.exe in ${root}. pick the folder Steam is installed in`);
  }
  paths.ensure_dir(root);
  const copied = [];
  for (const file of source.files) {
    const from = path.join(source.dir, file.name);
    const target = path.join(root, file.name);
    try {
      fs.copyFileSync(from, target);
    } catch (err) {
      throw explain(err, target);
    }
    // Copying is not proof: a locked or full disk can leave a short file behind.
    let written = 0;
    try { written = fs.statSync(target).size; } catch { /* gone again */ }
    if (written !== file.bytes) throw new Error(`${file.name} did not copy completely. close Steam and try again`);
    copied.push(file.name);
  }

  const toml_target = paths.toml_path();
  const toml_source = path.join(source.dir, TOML);
  try {
    if (paths.exists(toml_source)) fs.copyFileSync(toml_source, toml_target);
    else if (!paths.exists(toml_target)) fs.copyFileSync(path.join(paths.project_root(), 'tools', TOML), toml_target);
  } catch (err) {
    throw explain(err, toml_target);
  }

  // The Lua and manifest folders are where the app writes, so make sure they are there.
  try {
    paths.ensure_dir(paths.stplug_in());
    paths.ensure_dir(paths.depotcache());
  } catch (err) {
    throw explain(err, paths.stplug_in());
  }

  return { copied, toml: paths.exists(toml_target), state: state() };
}

// Removes only what this app put there: the proxy files and the TOML. Added games stay.
function remove() {
  if (paths.steam_running(true)) throw new Error('close Steam first, then remove the files');
  const removed = [];
  const failed = [];
  for (const name of [...names(), TOML]) {
    const target = path.join(paths.steam_root(), name);
    if (!paths.exists(target)) continue;
    try { fs.unlinkSync(target); removed.push(name); }
    catch (err) { failed.push(explain(err, target).message); }
  }
  if (failed.length) throw new Error(`could not remove ${failed.join(', ')}`);
  return { removed, state: state() };
}

module.exports = { state, install, remove, describe };
