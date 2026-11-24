'use strict';

// One version, one home: package.json is the source; this copies it into native/src/steamar.rc and
// roadmap.md, which cannot read it, and fails the check when either has drifted.
//   node tools/version.js          check (exit 1 on a mismatch)
//   node tools/version.js --write  rewrite the copies from package.json
// Trap: change the version in package.json only; a hand edit to a copy is reported as a mismatch.

// One version, one home. `package.json` is the source; this tool propagates it to the two files
// that cannot read it (the resource block in the exe needs literal numbers, the roadmap is prose)
// and fails the check when any of them has drifted.
//
//   node tools/version.js          check   (exit 1 on a mismatch)
//   node tools/version.js --write  rewrite the copies from package.json
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const RC = path.join(ROOT, 'native', 'src', 'steamar.rc');
// The roadmap is planning history that stays in the private repository; the public copy has none.
const ROADMAP = path.join(ROOT, 'roadmap.md');
const has_roadmap = fs.existsSync(ROADMAP);

const write = process.argv.includes('--write');

function read(file) { return fs.readFileSync(file, 'utf8'); }
function save(file, text) { fs.writeFileSync(file, text); }

const pkg = JSON.parse(read(path.join(ROOT, 'package.json')));
const version = String(pkg.version || '');
const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
if (!m) {
  console.error(`package.json version is "${version}", which is not a MAJOR.MINOR.PATCH number`);
  process.exit(1);
}
const [, major, minor, patch] = m;
const quad = `${major}, ${minor}, ${patch}, 0`;
const text = `${major}.${minor}.${patch}.0`;

const problems = [];
let rc = read(RC);
let roadmap = has_roadmap ? read(ROADMAP) : '';

const RC_NUM = /#define APP_VERSION .*/;
const RC_TEXT = /#define APP_VERSION_TEXT "[^"]*"/;
const RM_ROW = /(\| App \| This project's server and UI \| )([^ |]+)( \|)/;

const rc_num = RC_NUM.exec(rc);
const rc_text = RC_TEXT.exec(rc);
const rm_row = RM_ROW.exec(roadmap);
if (!rc_num || !rc_text) { console.error('steamar.rc no longer has the two APP_VERSION defines'); process.exit(1); }
if (has_roadmap && !rm_row) { console.error('roadmap.md no longer has the App row of the architecture table'); process.exit(1); }

if (rc_num[0] !== `#define APP_VERSION ${quad}`) problems.push(`steamar.rc  ${rc_num[0]}  ->  #define APP_VERSION ${quad}`);
if (rc_text[0] !== `#define APP_VERSION_TEXT "${text}"`) problems.push(`steamar.rc  ${rc_text[0]}  ->  #define APP_VERSION_TEXT "${text}"`);
if (has_roadmap && rm_row[2] !== version) problems.push(`roadmap.md  App row says ${rm_row[2]}  ->  ${version}`);

if (!problems.length) {
  console.log(`version ${version} is in sync (package.json, steamar.rc${has_roadmap ? ', roadmap.md' : ''})`);
  process.exit(0);
}

if (!write) {
  console.log(`version ${version} in package.json does not match:`);
  for (const line of problems) console.log(`  ${line}`);
  console.log('\nrun `npm run version:write` to copy package.json over them');
  process.exit(1);
}

rc = rc.replace(RC_NUM, `#define APP_VERSION ${quad}`).replace(RC_TEXT, `#define APP_VERSION_TEXT "${text}"`);
save(RC, rc);
if (has_roadmap) save(ROADMAP, roadmap.replace(RM_ROW, `$1${version}$3`));
console.log(`version ${version} written to steamar.rc${has_roadmap ? ' and roadmap.md' : ''}`);
