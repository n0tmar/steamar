'use strict';

// Stages a folder you can copy to another PC and run: the exe, the UI, the engine, a Node runtime
// inside the folder and any helper files already downloaded. It copies the exe and never builds it.
//   npm run portable            -> out/portable
//   npm run portable -- D:\USB  -> somewhere else
//   --zip writes <folder>.zip (what the updater installs), --setup <folder>-setup.exe (what people download)
// Trap: without --base (or STEAMAR_API_BASE) the copy keeps the service address in config/steam.json.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
};
// Where the copy looks for its service. The config on this machine points at the server in the next
// folder; a copy handed to somebody else has to point at an address they can reach, and that address
// is a packaging decision, not a code change.
const api_base = flag('base') || process.env.STEAMAR_API_BASE || null;
const target = path.resolve(argv.find((arg) => !arg.startsWith('--') && arg !== api_base) || path.join(root, 'out', 'portable'));
const exe = path.join(root, 'native', 'build', 'Release', 'SteaMar.exe');

if (!fs.existsSync(exe)) {
  console.error('build the app first: npm run build:app');
  process.exit(1);
}

const copy = (from, to) => {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, { recursive: true });
};

// Start clean so a stale file from an old build cannot ride along.
fs.rmSync(target, { recursive: true, force: true });
fs.mkdirSync(target, { recursive: true });

copy(exe, path.join(target, 'SteaMar.exe'));
for (const entry of ['ui', 'src', 'config', 'tools']) copy(path.join(root, entry), path.join(target, entry));
for (const entry of ['package.json', 'README.md']) {
  if (fs.existsSync(path.join(root, entry))) copy(path.join(root, entry), path.join(target, entry));
}

// The runtime is the one thing that makes this standalone: the exe looks in <folder>\runtime first
// and falls back to PATH, so a PC without Node still runs the app.
const node = process.execPath;
const runtime = path.join(target, 'runtime');
fs.mkdirSync(runtime, { recursive: true });
fs.copyFileSync(node, path.join(runtime, 'node.exe'));

// Whatever has already been downloaded travels with it, so a copy set up once works offline.
const vendor = path.join(root, 'vendor');
const has_vendor = fs.existsSync(path.join(vendor, 'vendor.json'));
if (has_vendor) copy(vendor, path.join(target, 'vendor'));

// The app writes logs, cache and window.ini here; an empty folder keeps the layout obvious.
fs.mkdirSync(path.join(target, 'out'), { recursive: true });

// The address this copy asks for its titles and keys. Written after the copy, so the folder on this
// machine keeps pointing at the local server and the handed-out copy points at the public one.
if (api_base) {
  const file = path.join(target, 'config', 'steam.json');
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  config.api = { ...(config.api || {}), base: api_base };
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

const count = (dir) => {
  let files = 0;
  let bytes = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const inner = count(full);
      files += inner.files;
      bytes += inner.bytes;
    } else {
      files += 1;
      bytes += fs.statSync(full).size;
    }
  }
  return { files, bytes };
};

const total = count(target);
const mb = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`;

console.log(`portable folder: ${target}`);
console.log(`  ${total.files} files, ${mb(total.bytes)}`);
console.log(`  runtime: ${path.basename(node)} ${process.version}`);
console.log(`  helper files included: ${has_vendor ? 'yes' : 'no - the app downloads them on first run'}`);
console.log(`  game list: served by the service, nothing downloaded`);
console.log(`  denuvo list: served by the service, nothing copied`);
console.log(`  service: ${api_base || '(the config as it is: ' + JSON.parse(fs.readFileSync(path.join(target, 'config', 'steam.json'), 'utf8')).api.base + ')'}`);

// A shortcut that starts the app from its own folder, for people who keep the folder somewhere deep.
const shortcut = [
  '@echo off',
  'cd /d "%~dp0"',
  'start "" "SteaMar.exe"',
].join('\r\n');
fs.writeFileSync(path.join(target, 'SteaMar.bat'), `${shortcut}\r\n`, 'utf8');

// A zip is the usual way to hand a portable app to someone else.
if (process.argv.includes('--zip')) {
  const zip = `${target}.zip`;
  fs.rmSync(zip, { force: true });
  // Windows' own tar writes zips. From Git Bash, plain `tar` is GNU tar, which cannot, and reads D:\ as a host.
  const windows_tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  const made = spawnSync(fs.existsSync(windows_tar) ? windows_tar : 'tar', ['-a', '-c', '-f', zip, '-C', target, '.'], { windowsHide: true });
  if (made.status === 0) console.log(`  zipped: ${zip}`);
  else {
    console.error('  zip failed (tar returned ' + made.status + ')');
    process.exitCode = 1; // a release step that fails must not look like it worked
  }
}

// The installer the download page offers: Inno Setup 6 compiles native/setup.iss around this folder.
if (process.argv.includes('--setup')) {
  const iscc = [
    process.env.ISCC,
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Inno Setup 6', 'ISCC.exe'),
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Inno Setup 6', 'ISCC.exe'),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Inno Setup 6', 'ISCC.exe'),
  ].find((file) => file && fs.existsSync(file));
  const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const setup = `${target}-setup.exe`;
  fs.rmSync(setup, { force: true });
  if (!iscc) {
    console.error('  setup: Inno Setup 6 is not installed (winget install JRSoftware.InnoSetup), or set ISCC to its ISCC.exe');
    process.exitCode = 1;
  } else {
    const made = spawnSync(iscc, ['/Q', `/DStage=${target}`, `/DAppVersion=${version}`, `/O${path.dirname(setup)}`,
      `/F${path.basename(setup, '.exe')}`, path.join(root, 'native', 'setup.iss')], { windowsHide: true, encoding: 'utf8' });
    if (made.status === 0) console.log(`  setup: ${setup}`);
    else {
      console.error(`  setup failed (ISCC returned ${made.status})\n${made.stderr || made.stdout}`);
      process.exitCode = 1;
    }
  }
}
