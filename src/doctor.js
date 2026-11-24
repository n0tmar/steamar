'use strict';

// Command line checkup: Steam, the proxy DLLs, the TOML, scripts, the service and repair findings.
// It prints a table and exits 1 on any fail; it fixes nothing (repair.fix() does).
// Trap: the service row needs the network; offline it is a fail row, not a crash.

const fs = require('node:fs');
const path = require('node:path');
const paths = require('./paths');
const api = require('./api');
const lua = require('./lua');
const repair = require('./repair');
const rows = [];
function check(area, name, ok, detail) {
  rows.push({ area, name, state: ok ? 'ok' : 'fail', detail });
}
function note(area, name, detail) {
  rows.push({ area, name, state: 'info', detail });
}

function toml_report(file) {
  const body = fs.readFileSync(file, 'utf8');
  const section = (name) => body.split(/\r?\n/).some((l) => l.trim() === `[${name}]`);
  const entries = (body.match(/^\[\[inject\]\]/gm) || []).length;
  const enabled = entries > 0 && /^\s*all_games\s*=\s*(true|false)/m.test(body);
  return { body, section, entries, enabled };
}

async function main() {
  const root = paths.steam_root();
  check('runtime', 'steam root', paths.exists(path.join(root, 'steam.exe')), path.join(root, 'steam.exe'));

  for (const d of paths.proxy_dlls()) {
    const detail = d.present ? `${(fs.statSync(d.path).size / 1024).toFixed(0)} KB  ${d.path}` : `missing at ${d.path}`;
    check('runtime', `proxy ${d.name}`, d.present, detail);
  }

  const toml = paths.toml_path();
  const toml_present = paths.exists(toml);
  check('runtime', 'opensteamtool.toml', toml_present, toml_present ? toml : `missing at ${toml}`);

  if (toml_present) {
    const t = toml_report(toml);
    const sections = ['log', 'manifest', 'lua', 'inject', 'update', 'cloud'].filter((s) => t.section(s));
    note('runtime', 'toml sections', sections.join(', ') || 'none');
    check('injection', 'inject blocks', true, `${t.entries} [[inject]] entries`);
    const upd = /\[update\][\s\S]*?enabled\s*=\s*true/.test(t.body);
    note('runtime', 'auto-update', upd ? '[update] enabled = true, DLL swaps on next launch' : '[update] disabled');
  }

  const plug = paths.stplug_in();
  const plug_present = paths.exists(plug);
  const scripts = plug_present ? fs.readdirSync(plug).filter((f) => f.endsWith('.lua')) : [];
  check('data', 'stplug-in', plug_present, plug_present ? `${scripts.length} .lua files at ${plug}` : `missing at ${plug}`);

  // The titles, keys and tokens live on the service, so this is the one check in the doctor that
  // needs a network. Offline is a fail with a reason, not a crash: every other row still prints.
  await api.warm().catch(() => {});
  const service = api.state();
  const counts = api.counters();
  if (!service.configured) {
    check('data', 'service key', false, 'config/steam.json has no api.public_key, so no reply can be trusted');
  } else {
    check('data', 'service', service.enrolled && !service.last_error,
      service.last_error ? `${service.last_error.code}: ${service.last_error.message}`
        : `${service.base}  device ${service.device_id || 'none'}`);
    // A count, never a key: this line is safe to paste into a bug report.
    note('data', 'titles', counts.fetched
      ? `${counts.addable.toLocaleString()} addable, ${counts.titles.toLocaleString()} known, ${counts.depot_keys.toLocaleString()} depot keys`
      : 'the service has not answered yet');
  }

  // The supplier clones are no longer part of running the app: the tables they carry are served.
  // If one is still on disk it is dev material, so it is a note and never a failure.
  for (const key of ['manifesthub', 'manifesthub3']) {
    const dir = paths.data_dir(key);
    if (paths.exists(dir)) note('data', `clone ${key}`, `${dir} - only the importer reads this now`);
  }

  const depot = paths.depotcache();
  const manifests = paths.exists(depot) ? fs.readdirSync(depot).filter((f) => /\.manifest$/i.test(f)).length : 0;
  check('data', 'depotcache', paths.exists(depot), `${manifests} manifest files`);

  let failed = 0;
  let keyed = 0;
  let unkeyed = 0;
  for (const f of scripts) {
    const v = lua.validate(fs.readFileSync(path.join(plug, f), 'utf8'));
    if (!v.ok) {
      failed++;
      check('lua', f, false, v.errors[0]);
      continue;
    }
    for (const a of v.parsed.addappid) {
      // The key is inside the script, which is what Steam reads. Whether the service could still
      // reissue it is a different question, and not one this check can answer offline.
      if (a.key) keyed++;
      else unkeyed++;
    }
  }
  if (scripts.length) {
    check('lua', 'validation', failed === 0, `${scripts.length - failed}/${scripts.length} scripts parse`);
    note('lua', 'key coverage', `${keyed} depots carry a key in the script, ${unkeyed} are entitlement only`);
  }

  const running = paths.steam_running();
  note('process', 'steam.exe', running ? 'running (Lua drops and TOML edits hot-reload)' : 'stopped');

  // The same checkup the app offers: a dev machine with an old tool's DLL lying around should say
  // so here too, before a user finds it.
  const health = repair.inspect();
  if (!health.findings.length) {
    check('setup', 'checkup', true, 'files, config, folders and scripts are in order');
  }
  for (const finding of health.findings) {
    const detail = `${finding.title}: ${finding.detail}`;
    const name = finding.id.slice(0, 26);
    // Steam being open is not a fault; it is why a repair has to wait.
    if (finding.id === 'steam-running') note('setup', name, detail);
    else if (finding.severity === 'fix' || finding.severity === 'blocker') check('setup', name, false, detail);
    else note('setup', name, detail);
  }

  const pad = (s, n) => String(s).padEnd(n);
  console.log(`${pad('area', 10)} ${pad('check', 26)} ${pad('state', 6)} detail`);
  for (const r of rows) console.log(`${pad(r.area, 10)} ${pad(r.name, 26)} ${pad(r.state, 6)} ${r.detail}`);
  const fails = rows.filter((r) => r.state === 'fail').length;
  console.log(`\n${rows.filter((r) => r.state === 'ok').length} ok, ${fails} fail, ${rows.filter((r) => r.state === 'info').length} info`);
  process.exitCode = fails ? 1 : 0;
}

main().catch((err) => {
  console.error(`doctor: ${err.message}`);
  process.exitCode = 1;
});
