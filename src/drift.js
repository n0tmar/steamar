'use strict';

// Command line: hashes the proxy DLLs in Steam and reads each data repo's git HEAD, compares them
// with the baseline file named in config/steam.json, and writes out/drift.log.
// It changes nothing in Steam.
// Trap: with no baseline the first run writes one and gives no verdict; --update rewrites it.

const fs = require('node:fs');
const path = require('node:path');
const paths = require('./paths');
const git = require('./git');

function git_head(repo_dir) {
  if (!paths.exists(path.join(repo_dir, '.git'))) return null;
  return git.head(repo_dir);
}

function dll_state() {
  return paths.proxy_dlls().map((d) => {
    if (!d.present) return { name: d.name, present: false, sha256: null, bytes: 0 };
    const st = fs.statSync(d.path);
    return { name: d.name, present: true, sha256: paths.sha256(d.path), bytes: st.size };
  });
}

function repo_state() {
  const state = {};
  for (const key of Object.keys(paths.config().data)) {
    const dir = paths.data_dir(key);
    state[key] = { path: dir, present: paths.exists(dir), head: git_head(dir) };
  }
  return state;
}

function load_baseline() {
  const p = path.join(paths.project_root(), paths.config().baseline_file);
  if (!paths.exists(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function save_baseline(dlls, repos) {
  const p = paths.ensure_dir(path.dirname(path.join(paths.project_root(), paths.config().baseline_file)));
  const file = path.join(paths.project_root(), paths.config().baseline_file);
  fs.writeFileSync(file, JSON.stringify({ written: new Date().toISOString(), dlls, repos }, null, 2) + '\n', 'utf8');
  return file;
}

function main() {
  const update = process.argv.includes('--update');
  const dlls = dll_state();
  const repos = repo_state();
  const baseline = load_baseline();
  const lines = [];

  lines.push(`drift report  ${new Date().toISOString()}`);
  lines.push('');

  for (const d of dlls) {
    const prior = baseline?.dlls?.find((x) => x.name === d.name);
    let verdict = 'baseline';
    if (baseline) {
      if (!d.present) verdict = 'MISSING';
      else if (!prior || prior.sha256 !== d.sha256) verdict = 'CHANGED';
      else verdict = 'unchanged';
    }
    lines.push(`dll   ${d.name.padEnd(20)} ${d.present ? d.sha256.slice(0, 16) : 'absent'.padEnd(16)}  ${verdict}`);
  }

  lines.push('');

  for (const [key, r] of Object.entries(repos)) {
    const prior = baseline?.repos?.[key];
    let verdict = 'baseline';
    if (baseline) {
      if (!r.present) verdict = 'ABSENT';
      else if (!r.head) verdict = 'NO-GIT';
      else if (prior?.head !== r.head) verdict = 'MOVED';
      else verdict = 'unchanged';
    }
    lines.push(`repo  ${key.padEnd(20)} ${(r.head || 'n/a').padEnd(16)}  ${verdict}`);
  }

  const report = lines.join('\n') + '\n';
  const out = path.join(paths.ensure_dir(paths.out_dir()), 'drift.log');
  fs.writeFileSync(out, report, 'utf8');
  process.stdout.write(report);

  if (update || !baseline) {
    const file = save_baseline(dlls, repos);
    console.log(`baseline written  ${file}`);
  }
  console.log(`report            ${out}`);
}

main();
