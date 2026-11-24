'use strict';

// The name a script is saved under before it is replaced or removed, and the way back from it.
// Both halves live here because restoring must undo exactly what saving did.
// It writes no file; library.js does the saving and restoring.
// Trap: original() strips only the stamp; the older LEGACY pattern is tried only when it is absent.

const path = require('node:path');

// 2026-03-05T12:00:00.123Z with the colon and the dot made safe for a file name.
const STAMP = /-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z\.lua$/;
// Whatever an older build wrote. Only tried when the stamp above is not there.
const LEGACY = /-[\dTZ.-]+\.lua$/i;

const stamped = (file, now = new Date()) => `${path.basename(file, '.lua')}-${now.toISOString().replace(/[:.]/g, '-')}.lua`;

// "my-game-1-2026-03-05T12-00-00-123Z.lua" is "my-game-1.lua". The old pattern took any run of digits,
// dashes and T/Z off the end, so it also took the "-1" and restored over a different script.
const original = (name) => {
  const text = String(name);
  return STAMP.test(text) ? text.replace(STAMP, '.lua') : text.replace(LEGACY, '.lua');
};

module.exports = { stamped, original };
