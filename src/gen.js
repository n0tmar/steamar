'use strict';

// Command line: node src/gen.js --appid <id> writes <appid>.lua into out/ (or --out).
// Depots and keys come from the service's package answer, manifests from depotcache.
// It does not install into stplug-in; drop.js or the app does that.
// Trap: there is no local fallback; when the service does not answer, it exits 1.

const fs = require('node:fs');
const path = require('node:path');
const paths = require('./paths');
const api = require('./api');
const lua = require('./lua');

function parse_args(argv) {
  const args = { depot: [], manifest: [], size: [], out: paths.out_dir(), token: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--appid') args.appid = argv[++i];
    else if (a === '--depot') args.depot.push(argv[++i]);
    else if (a === '--from') args.from = argv[++i];
    else if (a === '--manifest') args.manifest.push(argv[++i]);
    else if (a === '--size') args.size.push(argv[++i]);
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--no-token') args.token = false;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!args.appid || !/^\d+$/.test(args.appid)) throw new Error('--appid <digits> is required');
  return args;
}

// depotcache filenames are <depot_id>_<manifest_id>.manifest; keep the highest manifest per depot.
function scan_depotcache() {
  const dir = paths.depotcache();
  const out = {};
  if (!paths.exists(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    const m = /^(\d+)_(\d+)\.manifest$/i.exec(name);
    if (!m) continue;
    const [, depot, manifest] = m;
    if (!out[depot] || BigInt(manifest) > BigInt(out[depot].manifest)) out[depot] = { manifest };
  }
  return out;
}

function pair(list, flag) {
  const out = {};
  for (const item of list) {
    const [k, v] = item.split('=');
    if (!k || !v) throw new Error(`bad ${flag} ${item}, expected <depot>=<value>`);
    out[k] = v;
  }
  return out;
}

async function main() {
  const args = parse_args(process.argv.slice(2));
  const appid = args.appid;

  // One call answers what the service knows: the depot list, a key for each depot, and the token.
  // There is no local table to fall back to, and guessing a key is worse than saying there is none.
  let pkg;
  try {
    pkg = await api.package_for(appid);
  } catch (err) {
    console.error(`no answer from the service for ${appid}: ${err.message}`);
    process.exit(1);
  }

  let depots = args.depot.map(String);
  let depot_source = depots.length ? 'command line' : null;
  let source_keys = {};
  let source_token = null;

  if (!depots.length && args.from) {
    const parsed = lua.parse(fs.readFileSync(path.resolve(args.from), 'utf8'));
    depots = parsed.addappid.map((a) => a.id).filter((id) => id !== appid);
    for (const a of parsed.addappid) if (a.key && a.id !== appid) source_keys[a.id] = a.key;
    source_token = parsed.addtoken.find((t) => t.id === appid)?.token || null;
    depot_source = path.resolve(args.from);
  }
  if (!depots.length) {
    depots = pkg.depots.map((d) => String(d.depot)).filter((d) => d !== appid);
    depot_source = `service (${pkg.source})`;
    if (!depots.length) {
      console.error(`the service lists no depots for appid ${appid}`);
      console.error(`  fix: node src/gen.js --appid ${appid} --depot <depot_id> [--depot ...]`);
      process.exit(1);
    }
  }

  const found = { ...source_keys };
  // The app's own id carries the app-level key; render() writes that line without a key, so the
  // entry would only collide with it.
  for (const d of pkg.depots) if (d.key && String(d.depot) !== appid) found[String(d.depot)] = d.key;
  const missing = depots.filter((d) => !found[d]);
  const token = args.token ? (pkg.token || source_token) : null;

  const cache = scan_depotcache();
  const manifests = {};
  for (const depot of depots) {
    if (cache[depot]) manifests[depot] = { manifest: cache[depot].manifest };
  }
  for (const [depot, manifest] of Object.entries(pair(args.manifest, '--manifest'))) {
    manifests[depot] = { ...(manifests[depot] || {}), manifest };
  }
  for (const [depot, size] of Object.entries(pair(args.size, '--size'))) {
    manifests[depot] = { ...(manifests[depot] || {}), size };
  }

  const source = lua.render(appid, found, manifests, token);
  const check = lua.validate(source);
  if (!check.ok) {
    console.error('generated script failed validation:');
    for (const e of check.errors) console.error('  ' + e);
    process.exit(1);
  }

  paths.ensure_dir(args.out);
  const target = path.join(args.out, `${appid}.lua`);
  fs.writeFileSync(target + '.tmp', source, 'utf8');
  fs.renameSync(target + '.tmp', target);

  const no_manifest = depots.filter((d) => !manifests[d]);
  console.log(`appid        ${appid}`);
  console.log(`depot list   ${depot_source}`);
  console.log(`depots       ${depots.length}`);
  console.log(`keys found   ${Object.keys(found).length} of ${depots.length} from the service`);
  if (missing.length) console.log(`no key      ${missing.join(', ')} (entitlement only)`);
  console.log(`token        ${token || 'none for this appid'}`);
  console.log(`manifests    ${Object.keys(manifests).length} from depotcache`);
  if (no_manifest.length) console.log(`no manifest ${no_manifest.join(', ')} (absent from depotcache; fetch via ManifestHub, then --manifest <depot>=<id>)`);
  console.log(`written      ${target}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
