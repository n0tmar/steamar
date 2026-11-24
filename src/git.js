'use strict';

// The one way this app asks git a question: head(), problem() and pull(), nothing else.
// stderr is captured, never inherited, so git's 'dubious ownership' text stays out of the log.
// The reason is kept, not just the null: problem() returns one line a person can act on.
// Trap: head() returns null on any failure, and pull() resolves { ok, text } and never throws.

// The one way this app asks git a question. Two rules, both learned the hard way:
//   - stderr is captured, never inherited. A repo owned by another account makes git print three
//     lines of `fatal: detected dubious ownership` plus a copy-paste hint, and with the default
//     stdio that lands in the app's own log on every status read.
//   - the reason is kept, not just the null. "head is null" is not actionable; "git will not read
//     this folder because it is owned by another account" is.
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const OPTIONS = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true };

function stderr_of(err) {
  const text = String((err && err.stderr) || (err && err.message) || '');
  return text.trim().split('\n').filter(Boolean)[0] || '';
}

// Short HEAD of the repo at `dir`, or null when there is no repo or git will not read it.
function head(dir) {
  try {
    return execFileSync('git', ['-C', dir, 'rev-parse', '--short', 'HEAD'], OPTIONS).trim();
  } catch {
    return null;
  }
}

// The same question, with the answer a person can act on: '' when git is happy, else one line.
function problem(dir) {
  if (!require('node:fs').existsSync(path.join(dir, '.git'))) return 'not a git repository';
  try {
    execFileSync('git', ['-C', dir, 'rev-parse', '--short', 'HEAD'], OPTIONS);
    return '';
  } catch (err) {
    const line = stderr_of(err);
    if (/dubious ownership/i.test(line)) {
      // git's own hint, minus the three lines of explanation
      return `git refuses this folder: it is owned by another Windows account. Run: git config --global --add safe.directory ${dir.replace(/\\/g, '/')}`;
    }
    return line || 'git did not answer';
  }
}

// Fast-forward pull, used by the refresh button. Resolves with what happened, never throws.
function pull(dir, timeout = 60000) {
  return new Promise((resolve) => {
    const { execFile } = require('node:child_process');
    execFile('git', ['-C', dir, 'pull', '--ff-only'], { ...OPTIONS, timeout }, (err, stdout, stderr) => {
      resolve({ ok: !err, text: String(stdout || stderr || (err && err.message) || '').trim().split('\n')[0] });
    });
  });
}

module.exports = { head, problem, pull };
