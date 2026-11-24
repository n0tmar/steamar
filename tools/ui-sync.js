'use strict';

// The exe serves the UI from native/build/Release/ui, not ui/; CMake copies it at build time, so
// an unbuilt edit to ui/ leaves the app showing yesterday's page. This compares, and can copy.
//   node tools/ui-sync.js          compare, exit 1 when the build is stale
//   node tools/ui-sync.js --write  copy ui/ over the build
// It never copies back. Trap: with no build folder it exits 0 and compares nothing.

// The exe serves the UI from the folder beside itself, not from ui/. CMake copies it at build
// time, so an edit to ui/ that nobody rebuilt leaves the running app showing yesterday's
// page — the bug looks like "my change did nothing". This compares the two and can copy one way.
//
//   node tools/ui-sync.js          compare, exit 1 when the build is stale
//   node tools/ui-sync.js --write  copy ui/ over the build
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'ui');
const DEST = path.join(ROOT, 'native', 'build', 'Release', 'ui');
// Every file in ui/: the page is a dozen scripts now, and a list kept here would be one more to forget.
const FILES = fs.readdirSync(SRC);

const write = process.argv.includes('--write');

if (!fs.existsSync(DEST)) {
  console.log(`no built app yet (${path.relative(ROOT, DEST)} is missing), nothing to compare`);
  process.exit(0);
}

const stale = [];
for (const name of FILES) {
  const from = path.join(SRC, name);
  const to = path.join(DEST, name);
  if (!fs.existsSync(from)) { stale.push(`${name}: missing from ui/`); continue; }
  if (!fs.existsSync(to)) {
    stale.push(`${name}: not in the build`);
    if (write) { fs.copyFileSync(from, to); console.log(`copied ${name} (was missing)`); }
    continue;
  }
  const a = fs.readFileSync(from);
  const b = fs.readFileSync(to);
  if (a.equals(b)) continue;
  stale.push(`${name}: the build has an older copy`);
  if (write) { fs.copyFileSync(from, to); console.log(`copied ${name} (${a.length} bytes)`); }
}

if (!stale.length) {
  console.log(`the build is serving the same UI as ui/ (${FILES.join(', ')})`);
  process.exit(0);
}

if (write) {
  console.log(`\n${stale.length} file(s) copied; restart the app to load them`);
  process.exit(0);
}

console.log('the exe is serving a different UI than ui/:');
for (const line of stale) console.log(`  ${line}`);
console.log('\nrun `npm run ui:sync` (or rebuild), then restart the app');
process.exit(1);
