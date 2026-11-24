'use strict';

// The library on disk: which game scripts sit in stplug-in and what each one is (read), and the one
// place that writes them (add, remove, restore), always keeping a backup of what it replaces.
// It does not decide what a script says: catalog.js resolves the package and lua.js renders it.
// Trap: Steam reads these files itself, so a removal in a running session needs a Steam restart
// before the same id can be added again; steam.js keeps that record.

const fs = require('node:fs');
const path = require('node:path');
const paths = require('./paths');
const lua = require('./lua');
const catalog = require('./catalog');
const backup_names = require('./backups');
const { steam_pid, read_removed, write_removed, prune_removed } = require('./steam');
const { bad_request, not_found } = require('./errors');

// The folders Steam keeps its manifests in. A second library on another disk is a normal install,
// so the client's own list is read rather than assumed to be single.
function steamapps_dirs() {
  const root = paths.steam_root();
  const dirs = [path.join(root, 'steamapps')];
  try {
    const body = fs.readFileSync(path.join(root, 'steamapps', 'libraryfolders.vdf'), 'utf8');
    for (const m of body.matchAll(/"path"\s+"([^"]+)"/g)) {
      dirs.push(path.join(m[1].replace(/\\\\/g, '\\'), 'steamapps'));
    }
  } catch { /* one library, or a fresh install with no vdf yet */ }
  return [...new Set(dirs)].filter((d) => paths.exists(d));
}

const acf = (text, key) => {
  const m = new RegExp(`"${key}"\\s+"([^"]*)"`).exec(text);
  return m ? m[1] : null;
};

// What Steam knows and the script cannot: whether the title is on this disk. `StateFlags` is a bit
// field and 4 is "fully installed", so a download in progress is not counted as one - which is what
// a person means by installed. The scripts are the shelf; this is the disk.
function disk_map() {
  const out = new Map();
  for (const dir of steamapps_dirs()) {
    let files = [];
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const f of files) {
      const m = /^appmanifest_(\d+)\.acf$/i.exec(f);
      if (!m) continue;
      let text = '';
      try { text = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }
      const flags = Number(acf(text, 'StateFlags')) || 0;
      out.set(m[1], {
        appid: m[1],
        name: acf(text, 'name'),
        state: flags,
        installed: (flags & 4) === 4,
        bytes: Number(acf(text, 'SizeOnDisk')) || 0,
        updated_at: Number(acf(text, 'LastUpdated')) || 0,
      });
    }
  }
  return out;
}

// A script's own app id is not reliably its first addappid: several shipped scripts list a depot
// first and the app last. Collect candidates and let the catalog pick the one appdetails knows.
function scripts() {
  const dir = paths.stplug_in();
  if (!paths.exists(dir)) return [];

  // One read of the disk per call, shared by every row: a library is a handful of files, and
  // asking per row would read the same manifests once per script.
  const disk = disk_map();

  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.lua'))
    .flatMap((f) => {
      const full = path.join(dir, f);
      let source;
      let stat;
      try {
        stat = fs.statSync(full);
        if (!stat.isFile()) return []; // a folder called x.lua is not a script
        source = fs.readFileSync(full, 'utf8');
      } catch {
        // Held by a scanner, or gone since the listing. One file Windows will not hand over this moment
        // must not empty the shelf and fail the status call; it is listed again the next time.
        return [];
      }
      const parsed = lua.parse(source);
      const check = lua.validate(source);
      const file_appid = f.replace(/\.lua$/i, '');
      const ids = parsed.addappid.map((a) => a.id);
      const candidates = [...new Set([file_appid, ...ids])].filter((x) => /^\d+$/.test(x)).slice(0, 5);
      const keys = parsed.addappid.filter((a) => a.key).length;
      // The script's name is the app it names, not the file it sits in: a file named after a depot
      // still belongs to the game in it. First candidate Steam has a manifest for wins.
      const local = candidates.map((id) => disk.get(id)).find(Boolean) || null;

      return [{
        appid: file_appid,
        file_appid,
        file: f,
        path: full,
        bytes: stat.size,
        mtime: stat.mtimeMs,
        kind: ids.length ? 'game' : 'config',
        candidates,
        depots: ids.filter((id) => id !== file_appid),
        keys,
        token: parsed.addtoken.length > 0,
        manifests: parsed.setManifestid.length,
        valid: check.ok,
        errors: check.errors,
        // The two facts a card can never guess at: is this on disk, and is the script able to
        // install it at all. `keyless` is the same line the checkup draws, so the card and the
        // repair list cannot disagree.
        installed: Boolean(local && local.installed),
        installed_bytes: local ? local.bytes : 0,
        installed_state: local ? local.state : null,
        keyless: ids.length > 0 && keys === 0,
      }];
    })
    .sort((a, b) => a.file.localeCompare(b.file));
}

// ---- writing the shelf: one script in stplug-in per game, and a backup before any overwrite ----

function backup(file) {
  if (!paths.exists(file)) return null;
  const dir = paths.ensure_dir(path.join(paths.out_dir(), 'backup'));
  const target = path.join(dir, backup_names.stamped(file));
  fs.copyFileSync(file, target);
  return target;
}

async function add_app(appid, file) {
  if (!/^\d+$/.test(String(appid))) throw bad_request('appid must be digits');
  const pkg = await catalog.resolve_package(appid);

  const depots = {};
  const manifests = {};
  for (const d of pkg.depots) {
    if (d.key) depots[d.depot] = d.key;
    if (d.manifest) manifests[d.depot] = { manifest: d.manifest, size: d.size };
  }

  const source = lua.render(pkg.appid, depots, manifests, pkg.token);
  const check = lua.validate(source);
  if (!check.ok) throw new Error(`generated script invalid: ${check.errors[0]}`);

  const fname = file && /^[\w.-]+\.lua$/i.test(String(file)) ? path.basename(String(file)) : `${pkg.appid}.lua`;
  const target = path.join(paths.ensure_dir(paths.stplug_in()), fname);
  const previous = backup(target);
  fs.writeFileSync(target + '.tmp', source, 'utf8');
  fs.renameSync(target + '.tmp', target);

  // Did this same Steam session drop the id earlier? Then the live license table has no slot
  // for it and only a restart rebuilds that table from the scripts on disk.
  const pid = paths.steam_running() ? steam_pid() : null;
  const removed = read_removed();
  const stamp = removed[String(pkg.appid)] || removed[fname.replace(/\.lua$/i, '')] || null;
  const restart_needed = Boolean(pid && stamp && stamp.pid === pid);
  if (prune_removed(removed, pid)) write_removed(removed);

  return {
    appid: pkg.appid,
    name: pkg.name,
    file: target,
    previous_backup: previous,
    depots: pkg.depots.length,
    keys: Object.keys(depots).length,
    manifests: Object.keys(manifests).length,
    token: Boolean(pkg.token),
    warnings: pkg.warnings,
    // What the pre-flight said, carried out of the write as well as into it: a script that was
    // written but cannot install anything is a different answer from a script that works.
    renderable: pkg.renderable !== false,
    partial: pkg.partial === true,
    reason: pkg.reason || null,
    reload: paths.steam_running() ? 'live' : 'on next Steam start',
    steam_restart_needed: restart_needed,
  };
}

async function remove_app(target) {
  const name = String(target.file || target.appid || '');
  if (!/^[\w.-]+\.lua$/i.test(name) && !/^\d+$/.test(name)) throw bad_request('bad script name');
  const file = name.endsWith('.lua') ? name : `${name}.lua`;
  const full = path.join(paths.stplug_in(), path.basename(file));
  if (!paths.exists(full)) return { removed: false, reason: 'no script' };
  const saved = backup(full);
  fs.rmSync(full);
  // Stamp the app id with the Steam session that just lost its license for it.
  const appid = path.basename(full, '.lua');
  if (paths.steam_running(true)) {
    const pid = steam_pid();
    if (pid) {
      const map = read_removed();
      prune_removed(map, pid);
      map[appid] = { pid, at: new Date().toISOString() };
      write_removed(map);
    }
  }
  return { removed: true, file: path.basename(full), backup: saved };
}

async function restore_backup(file) {
  const name = path.basename(String(file || ''));
  const dir = path.join(paths.out_dir(), 'backup');
  const full = path.join(dir, name);
  if (!name.endsWith('.lua') || !paths.exists(full)) throw not_found('backup not found');

  const source = fs.readFileSync(full, 'utf8');
  const check = lua.validate(source);
  if (!check.ok) throw new Error(`backup is not a valid script: ${check.errors[0]}`);

  const restored_name = backup_names.original(name);
  const target = path.join(paths.ensure_dir(paths.stplug_in()), restored_name);
  if (paths.exists(target)) backup(target);
  fs.writeFileSync(target + '.tmp', source, 'utf8');
  fs.renameSync(target + '.tmp', target);
  return { restored: restored_name, from: name };
}

module.exports = { scripts, steamapps_dirs, disk_map, add_app, remove_app, restore_backup };
