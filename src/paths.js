'use strict';

// Where things are: config/steam.json, the Steam folder, the folders derived from it, out/, data.
// Also small helpers (exists, sha256, size_of, ensure_dir), steam_running() and the engine port.
// It reads no game scripts, and set_paths() is the only writer, to config/steam.json.
// Trap: config() is read once and cached, so a hand edit needs an engine restart, and STEAM_ROOT
// in the environment wins over the file and makes set_paths() refuse a new Steam folder.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, execFile } = require('node:child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(PROJECT_ROOT, 'config', 'steam.json');

let cached = null;
function config() {
  if (!cached) cached = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, ''));
  return cached;
}

const project_root = () => PROJECT_ROOT;

// Steam moves: ask the registry (and the two usual paths) before trusting the stored value.
function detect_steam_root() {
  const probes = [
    ['HKCU\\Software\\Valve\\Steam', 'SteamPath'],
    ['HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam', 'InstallPath'],
    ['HKLM\\SOFTWARE\\Valve\\Steam', 'InstallPath'],
  ];
  for (const [key, name] of probes) {
    try {
      const out = execFileSync('reg', ['query', key, '/v', name], { encoding: 'utf8', windowsHide: true });
      const m = new RegExp(`${name}\\s+REG_SZ\\s+(.+)`).exec(out);
      if (!m) continue;
      const guess = m[1].trim().replace(/\//g, '\\');
      if (exists(path.join(guess, 'steam.exe'))) return real_case(guess);
    } catch { /* key not present */ }
  }
  for (const guess of ['C:\\Program Files (x86)\\Steam', 'C:\\Program Files\\Steam']) {
    if (exists(path.join(guess, 'steam.exe'))) return real_case(guess);
  }
  return null;
}

// The registry stores the path in whatever case Steam felt like; the disk knows the real one, and
// this is the string the UI shows in settings.
function real_case(dir) {
  try { return fs.realpathSync.native(dir).replace(/[\\/]+$/, ''); } catch { return dir.replace(/[\\/]+$/, ''); }
}

const trim_slash = (p) => String(p || '').replace(/[\\/]+$/, '');

// A relative value (an env override, a hand-edited config) is resolved once, here: nothing
// downstream should ever see a path that depends on the engine's working directory.
const absolute = (p) => path.resolve(trim_slash(p));

function steam_root() {
  if (process.env.STEAM_ROOT) return absolute(process.env.STEAM_ROOT);
  const stored = trim_slash(config().steam_root);
  if (stored && exists(path.join(stored, 'steam.exe'))) return stored;
  return detect_steam_root() || (stored ? absolute(stored) : 'C:\\Program Files (x86)\\Steam');
}

// The two folders the app writes into can be pointed somewhere else; empty means "derive from Steam".
const stplug_in = () => (config().stplug_in ? absolute(config().stplug_in) : path.join(steam_root(), 'config', 'stplug-in'));
const depotcache = () => (config().depotcache ? absolute(config().depotcache) : path.join(steam_root(), 'depotcache'));
const steamapps = () => path.join(steam_root(), 'steamapps');
const toml_path = () => path.join(steam_root(), 'opensteamtool.toml');
const out_dir = () => (process.env.STEAMAR_OUT ? path.resolve(process.env.STEAMAR_OUT) : path.join(PROJECT_ROOT, 'out'));
const data_dir = (key) => path.join(PROJECT_ROOT, config().data[key] || key);
const is_override = (key) => Boolean(trim_slash(config()[key]));
const dll_source = () => (config().dll_source ? absolute(config().dll_source) : path.join(PROJECT_ROOT, 'vendor'));

function exists(p) {
  try { fs.accessSync(p); return true; } catch { return false; }
}

// What a file is, as two numbers: its sha256 (read whole - these are DLLs and scripts, not videos) and
// its size, 0 when it is not there, so a caller can compare without a try of its own.
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const size_of = (file) => {
  try { return fs.statSync(file).size; } catch { return 0; }
};

function ensure_dir(p) {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

// Settings writes go to config/steam.json; an env override wins and blocks edits.
function set_paths(next = {}) {
  if (process.env.STEAM_ROOT && next.steam_root !== undefined) {
    throw new Error('STEAM_ROOT is set in the environment; unset it to edit the folder here');
  }
  const cfg = config();
  if (next.steam_root !== undefined) {
    const root = trim_slash(next.steam_root);
    if (!root) throw new Error('the Steam folder cannot be empty');
    if (!exists(path.join(root, 'steam.exe'))) throw new Error(`no steam.exe in ${root}`);
    cfg.steam_root = root.replace(/\//g, '\\');
  }
  // An empty value clears the override and lets the folder follow the Steam root again.
  for (const key of ['stplug_in', 'depotcache', 'dll_source']) {
    if (next[key] === undefined) continue;
    const value = trim_slash(next[key]);
    if (value) cfg[key] = value.replace(/\//g, '\\');
    else delete cfg[key];
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  cached = cfg;
  return cfg;
}


// tasklist costs ~80 ms per spawn, so never block a request on it: keep the last answer and refresh
// in the background once it goes stale.
let running_cache = { value: false, at: 0 };
let refreshing = false;
const RUNNING_TTL_MS = 5000;

function steam_running(fresh = false) {
  const known = running_cache.at > 0;
  const stale = Date.now() - running_cache.at >= RUNNING_TTL_MS;

  if (fresh || !known) {
    let value = false;
    try {
      const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq steam.exe', '/NH'], { encoding: 'utf8' });
      value = /steam\.exe/i.test(out);
    } catch { /* tasklist unavailable */ }
    running_cache = { value, at: Date.now() };
    return value;
  }

  if (stale && !refreshing) {
    refreshing = true;
    execFile('tasklist', ['/FI', 'IMAGENAME eq steam.exe', '/NH'], { encoding: 'utf8', windowsHide: true }, (err, stdout) => {
      // A failed spawn says nothing about Steam: keep the last answer instead of reporting it closed.
      if (!err) running_cache = { value: /steam\.exe/i.test(stdout || ''), at: Date.now() };
      else running_cache = { value: running_cache.value, at: Date.now() };
      refreshing = false;
    });
  }
  return running_cache.value;
}

function proxy_dlls() {
  return (config().proxy_dlls || []).map((name) => {
    const full = path.join(steam_root(), name);
    return { name, path: full, present: exists(full) };
  });
}

// The engine's port: 8788 unless PORT says otherwise. The shell and the origin check expect 8788.
const engine_port = () => Number(process.env.PORT || 8788);

module.exports = {
  sha256, size_of,
  engine_port,
  config, project_root, steam_root, detect_steam_root, stplug_in, depotcache, steamapps,
  toml_path, out_dir, data_dir, exists, ensure_dir, steam_running, proxy_dlls,
  set_paths, is_override, dll_source,
};
