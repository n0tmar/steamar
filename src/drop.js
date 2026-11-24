'use strict';

// Command line: copies a Lua script into stplug-in (or --dir) under a temp name, then renames it.
// It refuses a script lua.validate() rejects unless --force; --remove deletes the target instead.
// It keeps no backup, unlike library.js.
// Trap: --file is required even with --remove; the target is named after the file's base name.

const fs = require('node:fs');
const path = require('node:path');
const paths = require('./paths');
const lua = require('./lua');

function parse_args(argv) {
  const args = { force: false, remove: false, dir: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--file') args.file = argv[++i];
    else if (a === '--force') args.force = true;
    else if (a === '--remove') args.remove = true;
    else if (a === '--dir') args.dir = argv[++i];
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!args.file) throw new Error('--file is required');
  return args;
}

// Write to a temp name, validate, then single rename. Hot reload never sees a half-written file.
function main() {
  const args = parse_args(process.argv.slice(2));
  const source_path = path.resolve(args.file);
  if (!paths.exists(source_path)) throw new Error(`not found: ${source_path}`);

  const dir = paths.ensure_dir(args.dir ? path.resolve(args.dir) : paths.stplug_in());
  const target = path.join(dir, path.basename(source_path).replace(/\.tmp$/i, ''));

  if (args.remove) {
    if (paths.exists(target)) {
      fs.rmSync(target);
      console.log(`removed  ${target}`);
    } else {
      console.log(`absent   ${target}`);
    }
    return;
  }

  const source = fs.readFileSync(source_path, 'utf8');
  const check = lua.validate(source);
  if (!check.ok && !args.force) {
    console.error('refused: script failed validation');
    for (const e of check.errors) console.error('  ' + e);
    process.exit(1);
  }
  if (!check.ok) console.error('warning: validation failed, --force given');

  const tmp = target + '.tmp';
  fs.writeFileSync(tmp, source, 'utf8');
  fs.renameSync(tmp, target);

  console.log(`dropped  ${target}`);
  console.log(`appids   ${check.parsed.addappid.map((a) => a.id).join(', ') || 'none'}`);
  console.log(`reload   ${paths.steam_running() ? 'live, runtime rescans stplug-in' : 'on next Steam start'}`);
}

main();
