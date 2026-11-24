'use strict';

// A backup is the script as it was just before it was replaced or removed, saved with a time in its
// name. Restoring has to put it back under its own name. It used to cut the name with a pattern that
// also matched the end of the script's own name, so my-game-1.lua came back as my-game.lua, over the
// top of a different script (after backing that one up, which hid the damage).

const test = require('node:test');
const assert = require('node:assert/strict');
const backups = require('../src/backups');

const NOW = new Date('2026-03-05T12:00:00.123Z');

test('a saved name keeps the script name and carries the time', () => {
  assert.equal(backups.stamped('C:\\Steam\\config\\stplug-in\\730.lua', NOW), '730-2026-03-05T12-00-00-123Z.lua');
});

test('restoring undoes exactly what saving did, for any script name', () => {
  for (const file of ['730.lua', 'my-game-1.lua', 'my-game-1-2.lua', 'a-2026.lua', 'x-2026-03-05.lua', 'Game_Name.v2.lua', '1-2-3.lua']) {
    assert.equal(backups.original(backups.stamped(file, NOW)), file, file);
  }
});

test('a backup from an older build, with another kind of time in its name, still restores', () => {
  assert.equal(backups.original('730-20260305T120000Z.lua'), '730.lua');
  assert.equal(backups.original('730-1741176000000.lua'), '730.lua');
});

test('a name with no time in it is left alone', () => {
  assert.equal(backups.original('plain.lua'), 'plain.lua');
});
