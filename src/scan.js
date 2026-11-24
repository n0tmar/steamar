'use strict';

// Which game fixes are on disk, read from file markers in steamapps/common of every Steam library.
// File markers only: nothing is downloaded or executed. The fixes catalogue is onlinefix.js.
// Trap: rows are cached for 60 s against each common folder's mtime, which a fix copied into an
// existing game folder does not change, so a new fix can take up to a minute to show.

const fs = require('node:fs');
const path = require('node:path');
const paths = require('./paths');

// Ordered: the first hit wins, so a ReFix deployment is not reported as a Goldberg one.
const KINDS = [
  { kind: 'refix', files: ['ReFix.ini', path.join('ReFix', 'refix_steamhost64.exe')] },
  { kind: 'onlinefix', files: ['OnlineFix.ini', 'OnlineFix64.dll', 'OnlineFix.dll'] },
  { kind: 'coldclient', files: ['ColdClientLoader.ini', 'ColdClientLoader.exe'] },
  { kind: 'goldberg', files: [path.join('steam_settings', 'steam_appid.txt'), path.join('steam_settings', 'configs.ini')] },
  { kind: 'smartsteamemu', files: ['SmartSteamEmu.ini', 'steamclient64.dll'] },
];

const PROXY_NAMES = ['winmm.dll', 'version.dll', 'dwmapi.dll', 'xinput1_4.dll', 'dxgi.dll', 'winhttp.dll'];

function api_state(dir) {
  const p64 = path.join(dir, 'steam_api64.dll');
  const p32 = path.join(dir, 'steam_api.dll');
  const pick = fs.existsSync(p64) ? p64 : fs.existsSync(p32) ? p32 : null;
  if (!pick) return { present: false };
  return { present: true, file: path.basename(pick), bytes: fs.statSync(pick).size, sha256: paths.sha256(pick) };
}

// RealAppId / FakeAppId are the only two fields worth parsing; [Hashes] is opaque by design.
function ini_ids(file) {
  try {
    const body = fs.readFileSync(file, 'utf8');
    return {
      real_appid: (body.match(/^\s*RealAppId\s*=\s*(\d+)/im) || [])[1] || null,
      fake_appid: (body.match(/^\s*FakeAppId\s*=\s*(\d+)/im) || [])[1] || null,
    };
  } catch {
    return { real_appid: null, fake_appid: null };
  }
}

function scan_game_dir(dir) {
  if (!dir || !fs.existsSync(dir)) return { dir, fix: null };
  const hit = KINDS.find((k) => k.files.some((f) => fs.existsSync(path.join(dir, f))));
  const ini_name = hit ? (hit.kind === 'refix' ? 'ReFix.ini' : hit.kind === 'onlinefix' ? 'OnlineFix.ini' : null) : null;
  const ini = ini_name && fs.existsSync(path.join(dir, ini_name)) ? path.join(dir, ini_name) : null;
  const ids = ini ? ini_ids(ini) : { real_appid: null, fake_appid: null };

  return {
    dir,
    fix: hit ? hit.kind : null,
    ini_name,
    real_appid: ids.real_appid,
    fake_appid: ids.fake_appid,
    appid_txt: fs.existsSync(path.join(dir, 'steam_appid.txt'))
      ? (fs.readFileSync(path.join(dir, 'steam_appid.txt'), 'utf8').trim().slice(0, 12) || null)
      : null,
    api: api_state(dir),
    proxies: PROXY_NAMES.filter((n) => fs.existsSync(path.join(dir, n))),
  };
}

// Cache keyed on each common folder's own mtime: a game folder added or removed invalidates it at
// once. A fix copied inside an existing game folder does not touch that mtime, so it shows when the
// 60 s below run out.
let cache = { at: 0, key: '', rows: [] };

function common_dirs() {
  const root = paths.steam_root();
  const candidates = [path.join(root, 'steamapps', 'common')];
  // Library folders elsewhere on disk: parsed the same way the client reads them.
  const vdf = path.join(root, 'steamapps', 'libraryfolders.vdf');
  try {
    const body = fs.readFileSync(vdf, 'utf8');
    for (const m of body.matchAll(/"path"\s+"([^"]+)"/g)) {
      candidates.push(path.join(m[1].replace(/\\\\/g, '\\'), 'steamapps', 'common'));
    }
  } catch { /* single library */ }
  return [...new Set(candidates)].filter((d) => fs.existsSync(d));
}

function scan_common() {
  const dirs = common_dirs();
  const key = dirs.map((d) => `${d}:${fs.statSync(d).mtimeMs}`).join('|');
  if (key === cache.key && Date.now() - cache.at < 60_000) return cache.rows;

  const rows = [];
  for (const base of dirs) {
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(base, entry.name);
      const state = scan_game_dir(dir);
      if (!state.fix && !state.appid_txt) continue; // an untouched game folder is not this tab's business
      rows.push({ name: entry.name, ...state });
    }
  }
  cache = { at: Date.now(), key, rows };
  return rows;
}

module.exports = { scan_common, common_dirs, KINDS };
