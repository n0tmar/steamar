'use strict';

// Opens the built window against a throwaway service, a fake Steam folder and a temp out/, and reads
// the page over CDP: the engine starts, the page draws, nothing throws, closing it stops the engine.
// It clicks nothing and is not verify-app.js, which drives a real, signed-in install.
// Trap: ports 8788, 9222 and 18791 must be free, and the window still writes its own out/native.log.
//
//   npm run build:app && npm run smoke:app [-- shot.png]

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, execFileSync } = require('node:child_process');

const APP = path.join(__dirname, '..');
// An installed copy is smoked the same way: STEAMAR_EXE=<its folder>\SteaMar.exe.
const EXE = process.env.STEAMAR_EXE ? path.resolve(process.env.STEAMAR_EXE) : path.join(APP, 'native', 'build', 'Release', 'SteaMar.exe');
// The folder the engine should report: an installed copy is its own, a build in native/ is this app.
const COPY = process.env.STEAMAR_EXE ? path.dirname(EXE) : APP;
const SERVICE = path.join(APP, '..', 'server', 'src', 'server.js');
const shot = process.argv[2];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failed += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`);
};

const get_json = (port, route) => new Promise((resolve, reject) => {
  const req = http.get({ host: '127.0.0.1', port, path: route, timeout: 2000 }, (res) => {
    let body = '';
    res.on('data', (d) => { body += d; });
    res.on('end', () => { try { resolve(JSON.parse(body)); } catch (err) { reject(err); } });
  });
  req.on('error', reject);
  req.on('timeout', () => req.destroy(new Error('timeout')));
});
const answers = (port) => get_json(port, '/').then(() => true, (err) => err.message !== 'timeout' && !/ECONNREFUSED/.test(err.message));

(async () => {
  if (!fs.existsSync(EXE)) { console.log(`no ${EXE}: run npm run build:app first`); process.exit(2); }
  for (const port of [8788, 9222, 18791]) {
    if (await answers(port)) { console.log(`port ${port} is in use: close any running SteaMar first`); process.exit(2); }
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'steamar-smoke-'));
  const steam = path.join(root, 'Steam');
  for (const dir of [path.join(root, 'service', 'data'), path.join(root, 'out'), path.join(steam, 'config', 'stplug-in')]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(path.join(steam, 'steam.exe'), '');

  // No Discord credentials, so the service has no member gate and the window opens without a sign-in.
  const service = spawn(process.execPath, [SERVICE], {
    stdio: 'ignore',
    env: { ...process.env, STM_ROOT: path.join(root, 'service'), STM_CONFIG: path.join(root, 'service', 'config.json'),
      STM_HOST: '127.0.0.1', STM_PORT: '18791', STM_ENROLL_OPEN: '1', STM_ADMIN_TOKEN: 'smoke-only-0123456789abcdef' },
  });
  let health = null;
  for (let i = 0; i < 50 && !health; i += 1) {
    await wait(200);
    health = await get_json(18791, '/v1/health').catch(() => null);
  }
  const key = health && (health.key || (health.body && health.body.key));
  check('the throwaway service answers', Boolean(key));
  if (!key) { service.kill(); process.exit(1); }

  const started = Date.now();
  const app = spawn(EXE, ['--devtools', '--size', '1280x800'], {
    stdio: 'ignore',
    env: { ...process.env, STEAMAR_OUT: path.join(root, 'out'), STEAM_ROOT: steam,
      STEAMAR_API: 'http://127.0.0.1:18791', STEAMAR_API_KEY: key, STEAMAR_SITE: 'http://127.0.0.1:18791' },
  });

  let target = null;
  for (let i = 0; i < 120 && !target; i += 1) {
    await wait(250);
    const list = await get_json(9222, '/json/list').catch(() => null);
    target = list && list.find((t) => t.type === 'page' && t.url.includes('steamar.cc'));
  }
  check('the window opens', Boolean(target), target ? `${Date.now() - started} ms` : 'no page after 30 s');

  if (target) {
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject); });
    let id = 0;
    const pending = new Map();
    const thrown = [];
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.method === 'Runtime.exceptionThrown') thrown.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
      const done = pending.get(msg.id);
      if (!done) return;
      pending.delete(msg.id);
      msg.error ? done.reject(new Error(msg.error.message)) : done.resolve(msg.result);
    });
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      id += 1;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async (expression) => {
      const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      return res.exceptionDetails ? `threw: ${res.exceptionDetails.text}` : res.result.value;
    };

    await send('Runtime.enable');
    // Reload with the listener attached, so an error while the page boots is caught too.
    await send('Page.reload', { ignoreCache: true });
    await wait(6000);

    const status = await evaluate(`api('/api/status').then((s) => ({ root: s.root, steam: s.steam_root }))`);
    check('the engine is this copy', status && path.resolve(String(status.root)) === path.resolve(COPY), status && status.root);
    check('and reads the fake Steam folder, not the real one', status && path.resolve(String(status.steam)) === path.resolve(steam), status && status.steam);
    const drawn = await evaluate(`(() => {
      const setup = document.getElementById('setup');
      const title = document.getElementById('setup-title');
      return setup && !setup.hidden && title ? title.textContent : document.querySelector('.card') ? 'cards' : '';
    })()`);
    check('the page draws', Boolean(drawn) && !String(drawn).startsWith('threw'), drawn);
    check('a new PC is walked through the setup', drawn === 'Let’s get SteaMar working', drawn);
    check('nothing throws while it boots', thrown.length === 0, thrown.slice(0, 2).join(' | '));

    if (shot) {
      const png = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(shot, Buffer.from(png.data, 'base64'));
      console.log(`     screenshot: ${shot}`);
    }
    ws.close();
  }

  try { execFileSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* already gone */ }
  service.kill();
  await wait(1500);
  check('closing the window stops the engine', !(await answers(8788)));
  check('the Steam folder is untouched', fs.readdirSync(path.join(steam, 'config', 'stplug-in')).length === 0);
  fs.rmSync(root, { recursive: true, force: true });

  console.log(failed ? `\n${failed} check(s) failed` : '\nthe window works');
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
