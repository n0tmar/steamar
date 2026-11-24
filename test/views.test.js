'use strict';

// The self-test is the one press in Settings that says, in plain words, whether this machine can add a
// game. It must answer without the network and without leaving anything behind in Steam's folder, so it
// is run here against a Steam install that is only a folder tree.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const STEAM = fs.mkdtempSync(path.join(os.tmpdir(), 'stm-app-views-'));
process.env.STEAM_ROOT = STEAM;
process.env.STEAMAR_OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'stm-app-views-out-'));

const views = require('../src/views');

const by_id = (result) => Object.fromEntries(result.checks.map((check) => [check.id, check]));

test('an empty folder is not a Steam install, and the self-test says so instead of failing', () => {
  const result = views.selftest();
  const checks = by_id(result);
  assert.equal(result.ok, false);
  assert.equal(checks.steam.ok, false);
  assert.equal(checks.helper.ok, false);
  assert.equal(checks.lua.ok, false);
  assert.match(checks.lua.detail, /^SteaMar can't write to Steam's game folder/);
  assert.equal(checks.service.ok, false, 'a copy that has never enrolled is not answered');
});

test('a Steam folder with a writable plug-in folder counts its scripts and leaves no probe behind', () => {
  fs.writeFileSync(path.join(STEAM, 'steam.exe'), '');
  const plug = path.join(STEAM, 'config', 'stplug-in');
  fs.mkdirSync(plug, { recursive: true });
  fs.writeFileSync(path.join(plug, '730.lua'), 'addappid(730)\n');
  fs.writeFileSync(path.join(plug, '570.LUA'), 'addappid(570)\n');
  fs.writeFileSync(path.join(plug, 'notes.txt'), '');

  const checks = by_id(views.selftest());
  assert.equal(checks.steam.ok, true);
  assert.equal(checks.lua.ok, true);
  assert.equal(checks.lua.detail, '2 games added');
  assert.deepEqual(fs.readdirSync(plug).sort(), ['570.LUA', '730.lua', 'notes.txt']);
});

test('names are looked up only for app ids, so a path never reaches the name cache', async () => {
  assert.deepEqual(await views.names(['../../config/steam', '7 30', '', 'abc']), {});
});
