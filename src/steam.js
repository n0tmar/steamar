'use strict';

// The Steam client as a process: is it running, close it, start it, hand it a steam:// link,
// and the record of which app ids this Steam session has already lost.
// It does not write game scripts (library.js does) or read Steam's folders (paths.js does).
// Trap: a removal is only remembered for the Steam process that saw it; a new pid makes it stale.

const fs = require('node:fs');
const path = require('node:path');
const { execFile, execFileSync, spawn } = require('node:child_process');
const paths = require('./paths');
const { bad_request } = require('./errors');

// The proxy builds its injected license table once per Steam process: a script removed while
// Steam runs takes its app id out of that table, and writing the same id back in the same
// session has nothing to land in. So every removal is stamped with the steam.exe pid that saw
// it; an add that matches that pid is answered with "Steam has to read this again", and a pid
// from an older session is spent and ignored.
function steam_pid() {
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq steam.exe', '/NH'], { encoding: 'utf8', windowsHide: true });
    const m = /steam\.exe\s+(\d+)/i.exec(out);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function removed_file() {
  return path.join(paths.out_dir(), 'removed.json');
}

function read_removed() {
  try {
    const parsed = JSON.parse(fs.readFileSync(removed_file(), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function write_removed(map) {
  try {
    fs.writeFileSync(removed_file(), JSON.stringify(map, null, 2), 'utf8');
  } catch { /* out/ is not writable: the flag is a courtesy, not a requirement */ }
}

// Forget every stamp from a session that is no longer running.
function prune_removed(map, pid) {
  let changed = false;
  for (const key of Object.keys(map)) {
    if (!pid || map[key].pid !== pid) {
      delete map[key];
      changed = true;
    }
  }
  return changed;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Close Steam and open it again: the only way the injected license table gets rebuilt while the
// scripts on disk stay put. Refuses to lie about it - if Steam will not exit, say so.
async function stop_steam() {
  const exe = path.join(paths.steam_root(), 'steam.exe');
  if (!paths.exists(exe)) return true;
  if (!steam_pid()) return true;
  spawn(exe, ['-shutdown'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  for (let i = 0; i < 60; i += 1) {
    await sleep(500);
    if (!steam_pid()) return true;
  }
  return false;
}

async function restart_steam() {
  const exe = path.join(paths.steam_root(), 'steam.exe');
  if (!paths.exists(exe)) throw new Error(`no steam.exe in ${paths.steam_root()}`);

  const before = steam_pid();
  if (before) {
    const closed = await stop_steam();
    if (!closed) throw new Error('Steam did not close. a game may be running, so close it by hand and add the game again.');
  }

  write_removed({});
  paths.steam_running(true);
  spawn(exe, ['-silent'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  return { restarted: true, was_running: Boolean(before) };
}

// Hands the appid to the Steam client: install dialog, or launch if it is already installed.
function steam_open(appid, action) {
  if (!/^\d{1,12}$/.test(String(appid))) throw bad_request('appid must be digits');
  const url = action === 'play' ? `steam://rungameid/${appid}`
    : action === 'store' ? `steam://store/${appid}`
    : `steam://install/${appid}`;
  execFile('cmd', ['/c', 'start', '""', url], { windowsHide: true });
  return { opened: url };
}

module.exports = { steam_pid, read_removed, write_removed, prune_removed, stop_steam, restart_steam, steam_open };
