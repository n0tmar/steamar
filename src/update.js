'use strict';

// Downloads a release, checks it against the signed manifest, and stages it in out/update/stage.
// It does not swap files: update-apply.js does that after the window closes.
// Trap: nothing is unpacked before the checksum matches; a stage with no SteaMar.exe is not ready.

// Updating in place, from the answer the service already signed.
//
// The rule the whole thing hangs on: the bytes are checked against the checksum in the signed
// manifest before a single one of them is unpacked. A mirror can serve a zip; it cannot sign a
// manifest, so a tampered download fails here and the build that is running stays exactly as it was.
//
// The download and the swap are two different moments, because the app cannot replace a file it is
// running. This module gets the release onto the disk, verified, in out/update/stage. The shell then
// starts out/update/apply (src/update-apply.js in the folder, runtime/node.exe to run it) and closes
// the window; that script waits for the window, copies, and opens the new build. Everything before
// the restart is here, so the window can draw a bar instead of pretending to be busy.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const paths = require('./paths');
const vendor = require('./vendor');

const BUSY = new Set(['downloading', 'verifying', 'unpacking']);

let job = { state: 'idle', version: null, percent: 0, error: null, at: null };

const state = () => ({ ...job });
const dir = () => paths.ensure_dir(path.join(paths.out_dir(), 'update'));
const stage_dir = () => path.join(dir(), 'stage');

// The staged release has to be startable, not merely unpacked: a zip that carries an empty folder
// and no exe would otherwise be "ready" and the window would vanish for nothing.
const exe_in = (dir_path) => path.join(dir_path, 'SteaMar.exe');

function sha256_file(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function fail(message) {
  job = { ...job, state: 'failed', error: message, at: Date.now() };
  console.error(`update: ${message}`);
  return state();
}

// `release` is the `latest` object from the signed reply: { version, url, sha256, size, notes }.
// It is never a body from the page - the page has no say in where the bytes come from, which is the
// point of checking a checksum at all.
async function start(release = {}) {
  if (BUSY.has(job.state)) return state();

  const url = String(release.url || '');
  const want = String(release.sha256 || '').toLowerCase();
  const version = release.version ? String(release.version) : 'new';

  job = { state: 'downloading', version, percent: 0, error: null, at: Date.now() };
  if (!/^https?:\/\//i.test(url)) return fail('the service published no address for this build');
  // The version names the file the zip is saved as, and it arrives in a reply: it is held to what a
  // version looks like, so it cannot be a path.
  if (!/^[0-9a-z][0-9a-z.+-]{0,31}$/i.test(version)) return fail('this release names a version that cannot be a file name');
  // A manifest with no checksum is served as sha256: null, and the app reads that as "cannot be
  // verified" rather than "fine". Here is where that reading is acted on.
  if (!/^[a-f0-9]{64}$/.test(want)) return fail('this release carries no checksum, so it cannot be verified');
  if (!paths.exists(path.join(paths.project_root(), 'src', 'update-apply.js'))) {
    return fail('this copy has no updater in it - download the release instead');
  }

  const zip = path.join(dir(), `SteaMar-${version}.zip`);
  try {
    await vendor.fetch_file(url, zip, (got, total) => {
      job.percent = total ? Math.min(100, Math.round((got / total) * 100)) : 0;
    });

    job.state = 'verifying';
    const got = await sha256_file(zip);
    if (got !== want) {
      fs.rmSync(zip, { force: true });
      return fail('the download does not match the checksum the service signed');
    }

    job.state = 'unpacking';
    vendor.unpack(zip, stage_dir());
    if (!paths.exists(exe_in(stage_dir()))) {
      fs.rmSync(stage_dir(), { recursive: true, force: true });
      return fail('that release carries no SteaMar.exe');
    }

    // The zip has done its job. Keeping a 34 MB copy of a build that is about to be installed is how
    // a folder doubles in size every upgrade.
    fs.rmSync(zip, { force: true });
    job = { state: 'ready', version, percent: 100, error: null, at: Date.now() };
    console.log(`update: ${version} staged in ${stage_dir()}`);
    return state();
  } catch (err) {
    return fail(err.message || 'the update could not be downloaded');
  }
}

// Where the shell and the script find each other. Exported because the native route and this module
// must agree on one path, and a second guess is how an updater runs against the wrong folder.
const apply_script = () => path.join(paths.project_root(), 'src', 'update-apply.js');
const command = () => {
  const bundled = path.join(paths.project_root(), 'runtime', 'node.exe');
  const node = paths.exists(bundled) ? bundled : 'node.exe';
  return { node, script: apply_script(), stage: stage_dir(), root: paths.project_root() };
};

module.exports = { state, start, sha256_file, apply_script, command };
