'use strict';

// What the shelf says about the disk. Every case here is a reading that was wrong before it existed:
// a title that Steam has installed showed no differently from one it had never seen, and a script
// with no key looked as healthy as a working one because parsing it proved nothing about installing
// it. The library reads both, so a card can be honest about both.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/* ---------- a Steam install that is only a folder tree ---------- */

const STEAM = fs.mkdtempSync(path.join(os.tmpdir(), 'stm-app-lib-'));
const LIB2 = fs.mkdtempSync(path.join(os.tmpdir(), 'stm-app-lib2-'));
process.env.STEAM_ROOT = STEAM;

const write = (file, body) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, 'utf8');
};

const plug = path.join(STEAM, 'config', 'stplug-in');
const apps = path.join(STEAM, 'steamapps');
const apps2 = path.join(LIB2, 'steamapps');

// A manifest is what the client writes; the fields below are the ones that answer the question.
const manifest = (appid, { name, flags, bytes }) => write(path.join(apps, `appmanifest_${appid}.acf`), `"AppState"
{
	"appid"		"${appid}"
	"name"		"${name}"
	"StateFlags"		"${flags}"
	"SizeOnDisk"		"${bytes}"
	"LastUpdated"		"1735689600"
}
`);

// The shape gen.js writes: an app line, a token, and one keyed depot.
const script = (file, body) => write(path.join(plug, file), body);

manifest('730', { name: 'Counter-Strike 2', flags: 4, bytes: 32212254720 });
manifest('1118520', { name: 'Paralives', flags: 2, bytes: 0 });

script('730.lua', `addappid(730)
addtoken(730, "1234567890")
addappid(731, 1, "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef")
setManifestid(731, "4813426003549064298", 2614315776)
`);

// The file the checkup calls out: filled without a key, so Steam will refuse to install it.
script('1118520.lua', `addappid(1118520)
setManifestid(1118520, "8000000000000000000", 1073741824)
`);

// A second library on another disk, named in the client's own list.
write(path.join(apps, 'libraryfolders.vdf'), `"libraryfolders"
{
	"0"
	{
		"path"		"${STEAM.replace(/\\/g, '\\\\')}"
	}
	"1"
	{
		"path"		"${LIB2.replace(/\\/g, '\\\\')}"
	}
}
`);
write(path.join(apps2, 'appmanifest_620.acf'), `"AppState"
{
	"appid"		"620"
	"name"		"Portal 2"
	"StateFlags"		"4"
	"SizeOnDisk"		"12345"
	"LastUpdated"		"1735689600"
}
`);
script('620.lua', `addappid(620)
addappid(621, 1, "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef")
setManifestid(621, "1111111111111111111", 1024)
`);

const library = require('../src/library');

const row = (appid) => library.scripts().find((r) => r.file_appid === appid);

/* ---------- the disk ---------- */

test('a title Steam has installed is reported installed, with its size', () => {
  const r = row('730');
  assert.equal(r.installed, true, 'StateFlags 4 is fully installed');
  assert.equal(r.installed_bytes, 32212254720, 'the size is the one the client wrote, not a guess');
});

test('a title that is still downloading is not called installed', () => {
  const r = row('1118520');
  assert.equal(r.installed, false, 'StateFlags 2 is a download, which a person does not call installed');
  assert.equal(r.installed_state, 2, 'the raw flags travel, so a page can say "downloading" later');
});

test('a title installed in another library is still installed', () => {
  assert.equal(row('620').installed, true, 'the manifest is on disk, and the disk is what counts');
});

test('a second library folder is read, because a library on another disk is normal', () => {
  const dirs = library.steamapps_dirs();
  assert.equal(dirs.length, 2, 'the root library and the one the vdf names');
  assert.ok(dirs.includes(apps2), 'the second library is the one the client listed');
});

test('the disk map is keyed by app id and carries what the client wrote', () => {
  const disk = library.disk_map();
  assert.equal(disk.get('620').name, 'Portal 2', 'the name comes from the manifest');
  assert.equal(disk.get('620').installed, true);
  assert.equal(disk.get('730').bytes, 32212254720);
  assert.equal(disk.has('999999'), false, 'a title never installed has no entry, which is the answer');
});

/* ---------- the script ---------- */

test('a script with no depot key is marked, because it cannot install anything', () => {
  assert.equal(row('1118520').keyless, true, 'keys 0 over a game script is the checkup line');
  assert.equal(row('730').keyless, false, 'one key is enough');
});

test('a script that parses but carries no key is still valid, and both facts travel', () => {
  const r = row('1118520');
  assert.equal(r.valid, true, 'validity is about parsing, not about entitlement');
  assert.equal(r.keys, 0, 'nothing here pretends a key exists');
});

test('installed and keyless are separate answers about separate things', () => {
  const r = row('730');
  assert.equal(r.installed, true);
  assert.equal(r.keyless, false);
  assert.equal(row('1118520').installed, false, 'one title can be uninstalled and keyless at once');
});

test('every row carries the two fields, so a page never reads undefined', () => {
  for (const r of library.scripts()) {
    assert.equal(typeof r.installed, 'boolean', `${r.file} has an installed flag`);
    assert.equal(typeof r.keyless, 'boolean', `${r.file} has a keyless flag`);
  }
});

test('a folder called x.lua is not a script, and one odd entry does not empty the shelf', () => {
  const odd = path.join(plug, 'folder.lua');
  fs.mkdirSync(odd);
  try {
    const rows = library.scripts();
    assert.ok(rows.some((r) => r.file === '730.lua'), 'the real scripts are still listed');
    assert.equal(rows.some((r) => r.file === 'folder.lua'), false);
  } finally {
    fs.rmdirSync(odd);
  }
});
