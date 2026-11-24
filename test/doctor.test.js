'use strict';

// The doctor is the command-line report: one row per thing that must be true for an add to work, then
// a count. It is run on machines that are already broken, so the one promise it must keep is to print
// every row and a verdict, offline and without Steam, instead of stopping at the first missing piece.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

const DOCTOR = path.join(__dirname, '..', 'src', 'doctor.js');

test('a machine without Steam and without the service gets every row and a fail count, not a crash', async () => {
  const steam = fs.mkdtempSync(path.join(os.tmpdir(), 'stm-app-doctor-'));
  const env = {
    ...process.env,
    STEAM_ROOT: steam,
    STEAMAR_OUT: fs.mkdtempSync(path.join(os.tmpdir(), 'stm-app-doctor-out-')),
    STEAMAR_API: 'http://127.0.0.1:9',
  };
  const { code, stdout, stderr } = await new Promise((resolve) => {
    execFile(process.execPath, [DOCTOR], { env, timeout: 60000 }, (err, out, errout) => {
      resolve({ code: err ? err.code : 0, stdout: String(out), stderr: String(errout) });
    });
  });

  assert.equal(code, 1, 'a missing Steam is a failed check, so the exit code says so');
  assert.doesNotMatch(stderr, /doctor: /, 'the report finished instead of falling into its crash handler');
  assert.match(stdout, /^runtime\s+steam root\s+fail\s/m);
  assert.match(stdout, /^data\s+stplug-in\s+fail\s/m);
  assert.match(stdout, /^\d+ ok, [1-9]\d* fail, \d+ info$/m);
  assert.deepEqual(fs.readdirSync(steam), [], 'the doctor only reads the Steam folder');
});
