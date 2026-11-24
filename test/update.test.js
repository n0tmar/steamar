'use strict';

// The two halves of an in-place update, sealed off from the network and from the real app folder.
//
// What this file is for: an updater is the one piece of code that can leave a person with no app at
// all, so the rules it follows are asserted rather than trusted - no checksum means no download, a
// wrong checksum means no unpack, the copy never writes into the person's out/ folder, and the parts
// of config/steam.json that are theirs survive an upgrade.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'stm-update-'));
process.env.STEAMAR_OUT = path.join(ROOT, 'out');

const update = require('../src/update');

const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

test('a release with no checksum is refused before a byte is fetched', async () => {
  const answer = await update.start({ version: '9.9.9', url: 'https://example.invalid/SteaMar.zip', sha256: null });
  assert.equal(answer.state, 'failed');
  assert.match(answer.error, /checksum/);
});

test('a manifest with no address is refused too', async () => {
  const answer = await update.start({ version: '9.9.9', url: '', sha256: 'a'.repeat(64) });
  assert.equal(answer.state, 'failed');
  assert.match(answer.error, /address/);
});

test('the hash the update is checked against is the hash of the file on disk', async () => {
  const file = path.join(ROOT, 'payload.bin');
  const bytes = crypto.randomBytes(4096);
  fs.writeFileSync(file, bytes);
  assert.equal(await update.sha256_file(file), sha256(bytes));
});

test('the staged release is looked for where the shell will start it', () => {
  const command = update.command();
  // One path, two readers: the module stages, the native route starts. A second guess is how an
  // updater runs against the wrong folder.
  assert.equal(path.basename(command.stage), 'stage');
  assert.equal(path.basename(path.dirname(command.stage)), 'update');
  assert.equal(command.script, update.apply_script());
  assert.ok(fs.existsSync(command.script), 'the applier ships in src/');
});

/* ---------- the applier, on a folder built for it ---------- */

// A whole pretend install: the applier lives in <root>/src, the release waits in out/update/stage,
// and the person's config and out/ contents are there to be preserved or overwritten - the two
// things that go wrong in real updates.
function make_install() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stm-apply-'));
  const write = (rel, text) => {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };

  write('src/update-apply.js', fs.readFileSync(path.join(__dirname, '..', 'src', 'update-apply.js'), 'utf8'));
  write('SteaMar.exe', 'old exe');
  write('ui/app.js', 'old ui');
  write('config/steam.json', JSON.stringify({
    api: { base: 'https://old.example', public_key: 'old-key' },
    steam_root: 'D:\\Games\\Steam',
    stplug_in: 'D:\\Games\\Steam\\config\\stplug-in',
  }, null, 2));
  write('out/backup/1234-now.lua', 'a person\'s backup');
  write('out/device.json', '{"device_id":"dev_1"}');

  write('out/update/stage/SteaMar.exe', 'new exe');
  write('out/update/stage/ui/app.js', 'new ui');
  write('out/update/stage/ui/index.html', 'new page');
  // A release that carries an out/ would otherwise be able to erase the person's cache.
  write('out/update/stage/out/device.json', '{"device_id":"nobody"}');
  write('out/update/stage/config/steam.json', JSON.stringify({
    api: { base: 'https://steamar.cc', public_key: 'new-key' },
    steam_root: '',
  }, null, 2));

  return root;
}

test('the applier copies the release, keeps the person\'s files, and merges the config', () => {
  const root = make_install();
  const stage = path.join(root, 'out', 'update', 'stage');

  const run = spawnSync(process.execPath, [path.join(root, 'src', 'update-apply.js'), stage], {
    cwd: root,
    timeout: 60000,
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(run.status, 0, run.stderr || run.stdout);

  assert.equal(fs.readFileSync(path.join(root, 'SteaMar.exe'), 'utf8'), 'new exe', 'the exe is replaced');
  assert.equal(fs.readFileSync(path.join(root, 'ui', 'app.js'), 'utf8'), 'new ui');
  assert.ok(fs.existsSync(path.join(root, 'ui', 'index.html')), 'a new file lands');
  assert.equal(fs.existsSync(stage), false, 'the staged copy is gone once it is installed');

  // The person's folder is theirs: their backup and their device identity are untouched.
  assert.equal(fs.readFileSync(path.join(root, 'out', 'backup', '1234-now.lua'), 'utf8'), 'a person\'s backup');
  assert.equal(fs.readFileSync(path.join(root, 'out', 'device.json'), 'utf8'), '{"device_id":"dev_1"}');

  // The release owns the API; the person owns where Steam is.
  const config = JSON.parse(fs.readFileSync(path.join(root, 'config', 'steam.json'), 'utf8'));
  assert.equal(config.api.base, 'https://steamar.cc', 'the release brings the new address and pin');
  assert.equal(config.api.public_key, 'new-key');
  assert.equal(config.steam_root, 'D:\\Games\\Steam', 'a path the person set is not reset by an update');
  assert.equal(config.stplug_in, 'D:\\Games\\Steam\\config\\stplug-in');
  assert.equal(fs.existsSync(path.join(root, 'out', 'update', 'backup')), false, 'the old files are not kept once it worked');
});

// The installer runs this after it has copied a release over a copy that was already there.
test('the installer\'s config step merges by the same rule, and touches nothing else', () => {
  const root = make_install();
  const config_step = (file) => spawnSync(process.execPath, [path.join(root, 'src', 'update-apply.js'), '--config', file], {
    cwd: root,
    timeout: 60000,
    encoding: 'utf8',
    windowsHide: true,
  });

  const run = config_step(path.join(root, 'out', 'update', 'stage', 'config', 'steam.json'));
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const config = JSON.parse(fs.readFileSync(path.join(root, 'config', 'steam.json'), 'utf8'));
  assert.equal(config.api.public_key, 'new-key', 'the release brings its pin');
  assert.equal(config.steam_root, 'D:\\Games\\Steam', 'the person keeps where Steam is');
  assert.equal(fs.readFileSync(path.join(root, 'SteaMar.exe'), 'utf8'), 'old exe', 'no file is copied');
  assert.ok(fs.existsSync(path.join(root, 'out', 'update', 'stage', 'SteaMar.exe')), 'the staged release is left alone');

  const before = fs.readFileSync(path.join(root, 'config', 'steam.json'), 'utf8');
  assert.equal(config_step(path.join(root, 'nothing.json')).status, 1, 'a config that is not there is a failure');
  assert.equal(fs.readFileSync(path.join(root, 'config', 'steam.json'), 'utf8'), before, 'and changes nothing');
});

// Holds a file the way a virus scan or an open editor does: no sharing at all, so it can be neither
// replaced nor moved until the holder lets go.
function hold(file) {
  const quoted = file.replace(/'/g, "''");
  const holder = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `$f = [System.IO.File]::Open('${quoted}', 'Open', 'Read', 'None'); [Console]::Out.WriteLine('held'); Start-Sleep -Seconds 60`],
  { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  return new Promise((resolve, reject) => {
    holder.stdout.on('data', (chunk) => { if (String(chunk).includes('held')) resolve(holder); });
    holder.on('exit', () => reject(new Error(`could not hold ${file}`)));
  });
}

test('a file another program holds open makes the applier put the old build back', { skip: process.platform !== 'win32' && 'needs Windows file locking' }, async () => {
  const root = make_install();
  const stage = path.join(root, 'out', 'update', 'stage');
  // Copied before the held file, so the undo has a new file to take out as well as old ones to restore.
  fs.writeFileSync(path.join(stage, 'ui', 'a-new.js'), 'a file the old build never had');

  const holder = await hold(path.join(root, 'ui', 'app.js'));
  let run;
  try {
    run = spawnSync(process.execPath, [path.join(root, 'src', 'update-apply.js'), stage], {
      cwd: root, timeout: 60000, encoding: 'utf8', windowsHide: true,
    });
  } finally {
    // The file is only free to read once the holder has really gone.
    const gone = new Promise((resolve) => holder.once('exit', resolve));
    holder.kill();
    await gone;
  }
  assert.equal(run.status, 2, run.stderr || run.stdout);

  assert.equal(fs.readFileSync(path.join(root, 'SteaMar.exe'), 'utf8'), 'old exe', 'the exe copied before the failure is put back');
  assert.equal(fs.readFileSync(path.join(root, 'ui', 'app.js'), 'utf8'), 'old ui');
  assert.equal(fs.existsSync(path.join(root, 'ui', 'a-new.js')), false, 'a file the release added is taken out again');
  assert.equal(fs.existsSync(path.join(root, 'ui', 'index.html')), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'config', 'steam.json'), 'utf8')).api.base, 'https://old.example', 'the config is not merged');
  assert.ok(fs.existsSync(path.join(stage, 'SteaMar.exe')), 'the staged release stays to try again');
  assert.match(fs.readFileSync(path.join(root, 'out', 'update', 'last.log'), 'utf8'), /the old build is back as it was/);
  assert.equal(fs.existsSync(path.join(root, 'out', 'update', 'backup')), false, 'nothing is left in the backup');
});

test('with nothing staged the applier changes nothing and says so', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stm-apply-empty-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.copyFileSync(path.join(__dirname, '..', 'src', 'update-apply.js'), path.join(root, 'src', 'update-apply.js'));

  const run = spawnSync(process.execPath, [path.join(root, 'src', 'update-apply.js')], {
    cwd: root,
    timeout: 30000,
    encoding: 'utf8',
    windowsHide: true,
  });
  // 1 is this script's way of saying "there was nothing to apply" - a fact, not a crash.
  assert.equal(run.status, 1, run.stderr || run.stdout);

  assert.equal(fs.existsSync(path.join(root, 'SteaMar.exe')), false, 'no exe appears from nowhere');
  const log = fs.readFileSync(path.join(root, 'out', 'update', 'last.log'), 'utf8');
  assert.match(log, /nothing to do/);
});

test('a version that is a path is refused, so the zip cannot be written anywhere else', async () => {
  for (const version of ['..\\..\\evil', '../../evil', 'C:\\x', '1.0.0/../../x', '', 'a'.repeat(33)]) {
    const answer = await update.start({ version, url: 'https://example.invalid/SteaMar.zip', sha256: 'a'.repeat(64) });
    if (version === '') {
      // No version at all is "new", which is a fine name; it fails later, on the unreachable address.
      assert.doesNotMatch(answer.error || '', /cannot be a file name/);
      continue;
    }
    assert.equal(answer.state, 'failed', JSON.stringify(version));
    assert.match(answer.error, /cannot be a file name/, JSON.stringify(version));
  }
});

test('the applier refuses a staged folder that is not inside out/update, and touches nothing', () => {
  const root = make_install();
  // The same release, staged somewhere else: next to the install rather than inside its update folder.
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'stm-elsewhere-'));
  fs.writeFileSync(path.join(elsewhere, 'SteaMar.exe'), 'new exe');
  fs.writeFileSync(path.join(elsewhere, 'precious.txt'), 'not the updater\'s to delete');

  const run = spawnSync(process.execPath, [path.join(root, 'src', 'update-apply.js'), elsewhere], {
    cwd: root,
    timeout: 60000,
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(run.status, 1, run.stderr || run.stdout);

  assert.equal(fs.readFileSync(path.join(root, 'SteaMar.exe'), 'utf8'), 'old exe', 'nothing was copied');
  assert.equal(fs.readFileSync(path.join(elsewhere, 'precious.txt'), 'utf8'), 'not the updater\'s to delete', 'and nothing was deleted');
  assert.match(fs.readFileSync(path.join(root, 'out', 'update', 'last.log'), 'utf8'), /refusing/);

  // The install's own update folder itself is not a staged release either.
  const same = spawnSync(process.execPath, [path.join(root, 'src', 'update-apply.js'), path.join(root, 'out', 'update')], {
    cwd: root, timeout: 60000, encoding: 'utf8', windowsHide: true,
  });
  assert.equal(same.status, 1);
  assert.ok(fs.existsSync(path.join(root, 'out', 'update', 'stage', 'SteaMar.exe')), 'the real stage is still there');
});
