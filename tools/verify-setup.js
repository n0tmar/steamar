'use strict';

// End-to-end check of first run: a staged portable copy with nothing, the real exe, a fake Steam root.
// It downloads for real (about a minute) and is not part of the unit tests.
// Trap: out/setup-check is removed when it finishes unless --keep is given.

// Proves the first-run story, end to end, on a copy of the app that has nothing:
// no vendor/, no game list, and a Steam folder with no helper files. It stages the portable
// folder, wipes the two download targets, launches the real exe against a fake Steam root,
// and presses the two buttons a new user presses.
//
//   npm run verify:setup            (about a minute: it really downloads 17 MB)
//   npm run verify:setup -- --keep  (leave out/setup-check for inspection)
//
// Exits non-zero if any step is wrong. This is the check for "portable and self-contained":
// if it passes, copying the folder to a machine with nothing installed works.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync, execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const keep = process.argv.includes('--keep');
const copy = path.join(root, 'out', 'setup-check');
const fake_steam = path.join(root, 'out', 'setup-check-steam');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
const check = (name, actual, expected) => {
  const ok = String(actual) === String(expected);
  if (!ok) failed += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(22)} ${actual}${ok ? '' : `  (expected ${expected})`}`);
};

const stop = (pid) => {
  try { execFileSync('taskkill', ['/F', '/PID', String(pid)], { stdio: 'ignore' }); } catch { /* already gone */ }
};

const get = (p) =>
  new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: 9222, path: p }, (res) => {
      let s = '';
      res.on('data', (d) => { s += d; });
      res.on('end', () => { try { resolve(JSON.parse(s)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });

(async () => {
  // a fresh copy, with the two download targets removed the way a new machine would have them
  fs.rmSync(copy, { recursive: true, force: true });
  fs.rmSync(fake_steam, { recursive: true, force: true });
  const staged = spawnSync(process.execPath, [path.join(root, 'tools', 'portable.js'), copy], { encoding: 'utf8' });
  if (staged.status !== 0) throw new Error(`could not stage: ${staged.stderr || staged.stdout}`);
  for (const dir of ['vendor', 'ManifestHub3']) fs.rmSync(path.join(copy, dir), { recursive: true, force: true });

  // The copy borrows this machine's device identity when there is one. A fresh enrolment is a new
  // device on the server, and the server allows five from one address an hour on purpose - running
  // this check five times in an hour must not read as "the app cannot reach its service".
  for (const file of ['device.json', 'device.key', 'install.id']) {
    const from = path.join(root, 'out', file);
    if (!fs.existsSync(from)) continue;
    fs.mkdirSync(path.join(copy, 'out'), { recursive: true });
    fs.copyFileSync(from, path.join(copy, 'out', file));
  }
  for (const dir of ['config\\stplug-in', 'depotcache']) fs.mkdirSync(path.join(fake_steam, dir), { recursive: true });
  fs.writeFileSync(path.join(fake_steam, 'steam.exe'), '');

  const app = spawn(path.join(copy, 'SteaMar.exe'), ['--devtools'], {
    detached: true, stdio: 'ignore', env: { ...process.env, STEAM_ROOT: fake_steam },
  });
  app.unref();
  const pid = app.pid;

  try {
    let target = null;
    for (let i = 0; i < 160 && !target; i += 1) {
      await wait(250);
      try {
        const list = await get('/json/list');
        target = list.find((t) => t.type === 'page' && t.url.includes('steamar.cc'));
      } catch { /* not up yet */ }
    }
    if (!target) throw new Error('no page target');

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });
    let id = 0;
    const pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      const done = pending.get(msg.id);
      if (!done) return;
      pending.delete(msg.id);
      msg.error ? done.reject(new Error(msg.error.message)) : done.resolve(msg.result);
    });
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const mine = ++id;
      pending.set(mine, { resolve, reject });
      ws.send(JSON.stringify({ id: mine, method, params }));
    });
    const evaluate = async (expression) => {
      const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (res.exceptionDetails) throw new Error(res.exceptionDetails.text);
      return res.result.value;
    };
    const settle = async (expression, want, tries = 60) => {
      for (let i = 0; i < tries; i += 1) {
        if (String(await evaluate(expression)) === String(want)) return want;
        await wait(500);
      }
      return evaluate(expression);
    };

    await send('Page.enable');
    await send('Runtime.enable');

    check('panel opens by itself', await settle('!document.getElementById("setup").hidden', true), true);
    check('step 1 is the Steam folder', await evaluate('(() => { const step = [...document.querySelectorAll(".sstep")].find((x) => /steam folder/i.test(x.textContent)); return step ? step.querySelector("em").textContent : "no step"; })()'), fake_steam);
    check('step 2 offers a download', await evaluate('!!document.querySelector("[data-act=\\"setup-fetch\\"]")'), true);
    check('set up starts disabled', await evaluate('document.querySelector("[data-act=\\"setup-install\\"]").disabled'), true);
    // "home says it has no list" used to be a state: the game list was a file, and a fresh copy had
    // none. The tables are served now, so a fresh copy has a store front the moment it can reach the
    // service - what it lacks is the helper files, which is step 2 below. "home has games" at the end
    // is the check that replaced it.

    await evaluate('document.querySelector("[data-act=\\"setup-fetch\\"]").click(); "pressed"');
    // the bar only exists while bytes are moving, so waiting for it proves the job reports progress
    const bar = await settle('!!document.querySelector(".sbar i")', true, 20);
    check('progress bar shows up', bar, true);

    const downloaded = await settle('(() => { const s = state.setup && state.setup.vendor; return Boolean(s && s.ready && s.data && s.data.ready); })()', true, 240);
    check('download lands the files', downloaded, true);
    check('helper files in vendor/', fs.existsSync(path.join(copy, 'vendor', 'dwmapi.dll')), true);
    check('the game list is the service\'s', await evaluate("api('/api/setup').then((s) => s.vendor.data.source)"), 'service');
    check('set up is enabled now', await settle('document.querySelector("[data-act=\\"setup-install\\"]").disabled', false), false);

    await evaluate('document.querySelector("[data-act=\\"setup-install\\"]").click(); "pressed"');

    // Steam being open on this PC is the one honest reason setup cannot copy: the files are locked.
    // The app must say so in step 3, and the copy checks are skipped rather than faked.
    const steam_up = await evaluate(`api('/api/status').then((s) => Boolean(s.steam_running))`);
    if (steam_up) {
      check('set up refuses while Steam runs', await settle('!!document.querySelector(".sstep:nth-child(3) em.err")', true, 40), true);
      check('the reason is readable', await evaluate('document.querySelector(".sstep:nth-child(3) em").textContent.includes("close Steam")'), true);
      console.log('skip three helper files in Steam — Steam is open; close it and run this again for the rest');
      console.log('skip toml in Steam');
      console.log('skip panel says set up');
    } else {
      check('panel says set up', await settle('!!document.querySelector(".setup-done")', true, 60), true);

      const after = await evaluate(`api('/api/status').then((s) => ({
        dlls: s.proxy_dlls.filter((d) => d.present).length,
        toml: s.toml,
      }))`);
      check('three helper files in Steam', after.dlls, 3);
      check('toml in Steam', after.toml, true);
    }

    // The counts are the service's answer, so a fresh copy asks and waits rather than reading a
    // mirror it does not have yet.
    const available = await settle(`api('/api/reach').then((s) => Number(s.games_total) > 0)`, true, 60);
    check('games available', available, true);
    // When this one is red the reason matters more than the verdict: the counts are the service's
    // answer, so print what the engine last heard.
    if (!available) console.log('  api state:', await evaluate(`api('/api/settings').then((s) => JSON.stringify({ counts: s.data.api.counts, last_error: s.data.api.last_error, enrolled: s.data.api.enrolled }))`));
    const state_now = await evaluate(`api('/api/status').then((s) => ({
      root: s.root,
    }))`);
    check('status names this copy', state_now.root.toLowerCase(), copy.toLowerCase());
    check('home has games', await settle('document.querySelectorAll("#view-home .card").length > 0', true, 40), true);
  } finally {
    stop(pid);
    await wait(500);
    if (!keep) {
      fs.rmSync(copy, { recursive: true, force: true });
      fs.rmSync(fake_steam, { recursive: true, force: true });
    }
  }

  console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(`setup check failed: ${err.message}`);
  process.exit(1);
});
