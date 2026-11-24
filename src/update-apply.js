'use strict';

// Standalone script the shell runs with runtime/node.exe: copies the staged release over the folder.
// The engine does not run it; it is the half of an update that happens after the window is gone.
// Trap: it refuses a stage outside out/update, and a copy that fails half way puts the old build back.

// The half of an update that runs after the window is gone.
//
// It is started by the shell a moment before the window closes, with runtime/node.exe so a machine
// needs nothing installed. It waits for SteaMar.exe to leave, copies the staged release over this
// folder, keeps the parts of config/steam.json that belong to the person rather than to the release
// (where Steam is, where the helper files came from), and starts the app again.
//
// It is deliberately dull and total: it writes one log line per step into out/update/last.log, it
// never deletes anything outside out/update (it refuses a stage that is not inside it), and every file
// it replaces is first moved into out/update/backup. When one file cannot be replaced (another program
// holds it open), the files already copied are taken out again, the old ones are moved back, and the
// old build starts as it was. The staged release stays, so the update can be tried again.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const STAGE = process.argv[2] ? path.resolve(process.argv[2]) : path.join(ROOT, 'out', 'update', 'stage');
const LOG_DIR = path.join(ROOT, 'out', 'update');
const BACKUP = path.join(LOG_DIR, 'backup');
const EXE = path.join(ROOT, 'SteaMar.exe');

// Strictly inside: the staged release is removed when the copy is done, so it has to be a folder this
// script's own update folder holds, never whatever an argument happens to name.
const inside = (parent, child) => {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
};

// What the copy has done so far, in order, so it can be undone: files whose old version now sits in
// BACKUP, and files the release added.
const moved = [];
const added = [];

function log(text) {
  const line = `${new Date().toISOString()} ${text}\n`;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(path.join(LOG_DIR, 'last.log'), line, 'utf8');
  } catch { /* a log that cannot be written is not a reason to stop an update */ }
  console.log(text);
}

// No async here on purpose: this process is the only thing between a closed window and a working
// install, and a promise that never settles would leave it hanging with no exe on screen.
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function running() {
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq SteaMar.exe', '/NH'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    return /steaMar\.exe/i.test(out);
  } catch {
    return false;
  }
}

// The old file is moved into BACKUP before the new one is copied in. A running image, such as the
// runtime this script runs on, cannot be overwritten but can be moved, so this one path serves both.
// A file another program holds open cannot even be moved: the error goes up and the copy is undone.
function copy_one(from, to) {
  const rel = path.relative(ROOT, to);
  try {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    if (fs.existsSync(to)) {
      const keep = path.join(BACKUP, rel);
      fs.mkdirSync(path.dirname(keep), { recursive: true });
      fs.renameSync(to, keep);
      moved.push(rel);
    } else {
      added.push(rel);
    }
    fs.copyFileSync(from, to);
  } catch (err) {
    err.file = rel;
    throw err;
  }
}

// Undo, newest first. Returns how many files could not be put back; those are named in the log, and
// their old versions stay in BACKUP.
function roll_back() {
  let left = 0;
  for (const rel of added.reverse()) {
    try { fs.rmSync(path.join(ROOT, rel), { force: true }); } catch (err) {
      left += 1;
      log(`could not remove the new ${rel} (${err.code || err.message})`);
    }
  }
  for (const rel of moved.reverse()) {
    try {
      fs.rmSync(path.join(ROOT, rel), { force: true });
      fs.renameSync(path.join(BACKUP, rel), path.join(ROOT, rel));
    } catch (err) {
      left += 1;
      log(`could not put back ${rel} (${err.code || err.message}); the old file is in ${path.join(BACKUP, rel)}`);
    }
  }
  return left;
}

// `out/` is the person's: caches, backups, the device key, this update folder. It is never copied
// over, and the release never carries anything that belongs there.
const SKIP_DIRS = new Set(['out']);
const SKIP_FILES = new Set([path.join('config', 'steam.json')]);

function copy_tree(from, into) {
  let copied = 0;
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const source = path.join(from, entry.name);
    const target = path.join(into, entry.name);
    if (entry.isDirectory()) {
      copied += copy_tree(source, target);
      continue;
    }
    if (SKIP_FILES.has(path.relative(ROOT, target))) continue;
    copy_one(source, target);
    copied += 1;
  }
  return copied;
}

// The release owns the API address and the pinned key. The person owns where Steam is installed and
// whether the folders were pointed somewhere else. A copy of the app that forgets the second half is
// an app that asks "where is Steam?" after every update.
const PERSONAL = ['steam_root', 'stplug_in', 'depotcache', 'dll_source', 'baseline_file'];

function merge_config(fresh = path.join(STAGE, 'config', 'steam.json')) {
  const mine = path.join(ROOT, 'config', 'steam.json');
  const read = (file) => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; }
  };
  const incoming = read(fresh);
  const current = read(mine);
  if (!incoming) return false;

  const merged = { ...incoming };
  if (current) {
    for (const key of PERSONAL) {
      if (current[key] !== undefined) merged[key] = current[key];
    }
  }
  fs.mkdirSync(path.dirname(mine), { recursive: true });
  fs.writeFileSync(`${mine}.tmp`, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  fs.renameSync(`${mine}.tmp`, mine);
  return true;
}

// A copy the installer put here is in Windows' list of installed apps with its version, and after an
// update that list would go on naming the old one. The key is native/setup.iss's AppId.
const LISTED = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{442375EF-34EA-4AB5-AEFB-FC35055A87A4}_is1';

function list_version() {
  if (!fs.existsSync(path.join(ROOT, 'unins000.exe'))) return;
  try {
    const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8').replace(/^\uFEFF/, ''));
    execFileSync('reg', ['query', LISTED], { windowsHide: true, stdio: 'ignore' });
    execFileSync('reg', ['add', LISTED, '/v', 'DisplayVersion', '/t', 'REG_SZ', '/d', String(version), '/f'], { windowsHide: true, stdio: 'ignore' });
    log(`Windows lists version ${version}`);
  } catch { /* not installed by the setup, or the list cannot be written: the update itself is done */ }
}

function clean_old() {
  // Earlier versions of this script left the replaced exe and runtime beside the new ones as `.old`
  // copies; removing them here keeps one mechanism rather than a cleanup somebody has to remember.
  for (const name of ['SteaMar.exe.old', 'runtime\\node.exe.old']) {
    try { fs.rmSync(path.join(ROOT, name), { force: true }); } catch { /* still in use: next time */ }
  }
}

function main() {
  if (!inside(LOG_DIR, STAGE)) {
    log(`refusing ${STAGE}: a staged release lives inside ${LOG_DIR}, and it is deleted when the copy is done`);
    return 1;
  }
  if (!fs.existsSync(path.join(STAGE, 'SteaMar.exe'))) {
    log(`no staged release in ${STAGE} - nothing to do`);
    return 1;
  }
  log(`waiting for SteaMar.exe to close (staged ${STAGE})`);
  for (let i = 0; i < 60 && running(); i += 1) sleep(500);
  // The job object that owns the engine dies with the window; the runtime needs a moment to go.
  sleep(800);

  // A backup left by an earlier update is not this one's to restore from.
  try { fs.rmSync(BACKUP, { recursive: true, force: true }); } catch { /* a file in it still runs */ }

  log('copying the release over this folder');
  let failed = null;
  try {
    log(`copied ${copy_tree(STAGE, ROOT)} file(s)`);
  } catch (err) {
    failed = err;
  }

  if (failed) {
    log(`could not replace ${failed.file || 'a file'} (${failed.code || failed.message}), so the old build is put back`);
    const left = roll_back();
    if (!left) {
      try { fs.rmSync(BACKUP, { recursive: true, force: true }); } catch { /* only empty folders were left */ }
    }
    log(left
      ? `${left} file(s) could not be put back, so this folder is a mix of two builds; the old files are in ${BACKUP}`
      : 'the old build is back as it was');
    log(`the staged release stays in ${STAGE} so the update can be tried again`);
  } else {
    log(merge_config() ? 'config/steam.json: release api, personal folders' : 'config/steam.json: nothing to merge');
    list_version();
    fs.rmSync(STAGE, { recursive: true, force: true });
    // The old runtime this script runs on sits in the backup and cannot go yet; the next update clears it.
    try { fs.rmSync(BACKUP, { recursive: true, force: true }); } catch { /* still running */ }
  }
  clean_old();

  if (!fs.existsSync(EXE)) {
    log('SteaMar.exe is missing after the copy - not starting anything');
    return 1;
  }
  log(failed ? 'starting the old build again' : 'starting the new build');
  try {
    const child = spawn(EXE, [], { cwd: ROOT, detached: true, stdio: 'ignore' });
    // A launch that fails must not take the updater down with an unhandled event after the files are
    // already in place: the person just has to open the app themselves.
    child.on('error', (err) => log(`could not start ${path.basename(EXE)}: ${err.message}`));
    child.unref();
  } catch (err) {
    // A copy of the app on a share, or a file a policy does not allow to run: the files are in
    // place, and the window is the person's to open.
    log(`could not start ${path.basename(EXE)}: ${err.message}`);
  }
  return failed ? 2 : 0;
}

// The installer's half (native/setup.iss): a setup run over a copy that is already here brings the
// release's config and keeps the person's folders, by the rule an update follows, and touches nothing else.
if (process.argv[2] === '--config') {
  process.exitCode = merge_config(path.resolve(process.argv[3] || '')) ? 0 : 1;
} else {
  try {
    process.exitCode = main();
  } catch (err) {
    log(`failed: ${err && err.message ? err.message : err}`);
    process.exitCode = 1;
  }
}
