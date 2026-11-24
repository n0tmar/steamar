'use strict';

// Set up copies three helper files into Steam, where they run inside the Steam process. A folder the
// person picks is somebody else's files: only a version SteaMar has a checksum for may be copied.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// A Steam folder of our own, so nothing here can reach the real one.
const STEAM = fs.mkdtempSync(path.join(os.tmpdir(), 'stm-setup-steam-'));
fs.writeFileSync(path.join(STEAM, 'steam.exe'), '');
process.env.STEAM_ROOT = STEAM;

const setup = require('../src/setup');

const NAMES = ['dwmapi.dll', 'xinput1_4.dll', 'OpenSteamTool.dll'];
// The public repository leaves the helper DLLs out, so there the real files are not here to mix.
const SHIPPED = NAMES.every((name) => fs.existsSync(path.join(__dirname, '..', 'vendor', name)));

test('set up refuses helper files from a folder when SteaMar has no checksum for them', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'stm-setup-picked-'));
  for (const name of NAMES) fs.writeFileSync(path.join(folder, name), `not the real ${name}`);
  assert.throws(() => setup.install(folder), /are not versions SteaMar has checked/);
  for (const name of NAMES) assert.equal(fs.existsSync(path.join(STEAM, name)), false, `${name} never reached Steam`);
});

test('one wrong file in the set is enough to refuse the whole set', { skip: !SHIPPED && 'the helper DLLs are not in this copy' }, () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'stm-setup-mixed-'));
  for (const name of NAMES) fs.copyFileSync(path.join(__dirname, '..', 'vendor', name), path.join(folder, name));
  fs.writeFileSync(path.join(folder, 'xinput1_4.dll'), 'swapped');
  assert.throws(() => setup.install(folder), /xinput1_4\.dll in .* is not a version SteaMar has checked/);
  for (const name of NAMES) assert.equal(fs.existsSync(path.join(STEAM, name)), false, `${name} never reached Steam`);
});
