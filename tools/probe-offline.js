'use strict';

// What the app says when the service is not there: a throwaway engine on port 8796, STEAMAR_API at
// a port nobody listens on, and a temp out/ with copies of the fixes and denuvo mirrors.
// It asks for a fix link as a click does and prints the status and body; the real out/ is untouched.
// Trap: it reads out/api/fixes.json of this copy, so it fails on a machine that never synced.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'stm-app-offline-'));
fs.mkdirSync(path.join(OUT, 'api'), { recursive: true });
for (const name of ['fixes.json', 'denuvo.json']) {
  const from = path.join(ROOT, 'out', 'api', name);
  if (fs.existsSync(from)) fs.copyFileSync(from, path.join(OUT, 'api', name));
}

const mirror = JSON.parse(fs.readFileSync(path.join(OUT, 'api', 'fixes.json'), 'utf8'));
const row = (mirror.body?.items || mirror.items || [])[0];
const PORT = 8796;
const child = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], {
  env: {
    ...process.env,
    PORT: String(PORT),
    STEAMAR_OUT: OUT,
    STEAMAR_API: 'http://127.0.0.1:8799',
    STEAMAR_API_KEY: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let said = '';
child.stdout.on('data', (d) => { said += d; });
child.stderr.on('data', (d) => { said += d; });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  let answer = null;
  for (let i = 0; i < 60; i += 1) {
    try {
      answer = await fetch(`http://127.0.0.1:${PORT}/api/fixes/link?id=${row.id}`);
      break;
    } catch { /* not up yet */ }
    await wait(150);
  }
  const body = answer ? await answer.json() : null;
  console.log(`release ${row.id}: ${answer?.status} ${JSON.stringify(body)}`);
  child.kill();
  fs.rmSync(OUT, { recursive: true, force: true });
  if (answer?.status !== 503 || body?.code !== 'unreachable') {
    console.error(said);
    process.exit(1);
  }
})();
