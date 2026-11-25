'use strict';

// The Bypass tab's engine half, sealed off from the network and from the person's real Downloads
// folder: what the list carries, where a download lands, and that a short one is never left looking
// finished.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const child = require('node:child_process');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'stm-bypass-app-'));
process.env.STEAMAR_OUT = path.join(ROOT, 'out');
process.env.USERPROFILE = ROOT; // what os.homedir() reads on Windows
process.env.HOME = ROOT;

const api = require('../src/api');
const vendor = require('../src/vendor');
const bypass = require('../src/bypass');

const DOWNLOADS = path.join(ROOT, 'Downloads');
const LISTED = [
  { appid: '5001', name: 'Half-Life: Alyx?', text: 'Put the files next to the game.', size: 5, updated: '2026-11-25T10:00:00.000Z' },
  { appid: '5002', name: 'Other Game', text: '', size: 5, updated: '2026-11-24T10:00:00.000Z' },
  { appid: '../5003', name: 'Not an id' },
];

async function settled(appid) {
  for (let i = 0; i < 200; i += 1) {
    const row = bypass.job(appid);
    if (row.state !== 'downloading') return row;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('still downloading');
}

test.after(() => { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* locked */ } });

test('the list carries what the tab draws, and drops a row with no real id', async (t) => {
  t.mock.method(api, 'bypass', async () => ({ games: LISTED }));
  const games = await bypass.list();
  assert.deepEqual(games.map((g) => [g.appid, g.image, g.hero, g.job.state]), [
    ['5001', '/img/5001.jpg', '/img/hero/5001.jpg', 'idle'],
    ['5002', '/img/5002.jpg', '/img/hero/5002.jpg', 'idle'],
  ]);
  assert.equal(games[0].text, 'Put the files next to the game.');
});

test('a file name is the game name Windows can hold', () => {
  assert.equal(bypass.file_name('Half-Life: Alyx?'), 'Half-Life Alyx bypass.zip');
  assert.equal(bypass.file_name('A<b>c. '), 'A b c bypass.zip');
  assert.equal(bypass.file_name(''), 'Game bypass.zip');
});

test('a download lands in Downloads under the game name, once the whole file is there', async (t) => {
  let asked = null;
  t.mock.method(api, 'bypass_link', async (appid) => ({ url: `/v1/bypass/file/${appid}?until=1&sig=x`, size: 5 }));
  t.mock.method(vendor, 'fetch_file', async (url, target, on_bytes) => {
    asked = url;
    on_bytes(2, 5);
    fs.writeFileSync(target, 'hello');
    return { bytes: 5, total: 5 };
  });

  const first = bypass.start('5001');
  assert.equal(first.state, 'downloading');
  assert.equal(bypass.start('5001'), first, 'a second press while it runs is the same download');
  const done = await settled('5001');
  assert.equal(done.state, 'done');
  assert.equal(done.file, path.join(DOWNLOADS, 'Half-Life Alyx bypass.zip'));
  assert.equal(fs.readFileSync(done.file, 'utf8'), 'hello');
  assert.equal(fs.existsSync(`${done.file}.part`), false);
  assert.equal(asked, new URL('/v1/bypass/file/5001?until=1&sig=x', api.base_url()).toString());
});

test('a download that comes up short is thrown away, and says so', async (t) => {
  t.mock.method(api, 'bypass_link', async () => ({ url: '/v1/bypass/file/5002?until=1&sig=x', size: 5 }));
  t.mock.method(vendor, 'fetch_file', async (url, target) => {
    fs.writeFileSync(target, 'hel');
    return { bytes: 3, total: 5 };
  });
  bypass.start('5002');
  const row = await settled('5002');
  assert.equal(row.state, 'failed');
  assert.match(row.error, /stopped before the end/);
  assert.deepEqual(fs.readdirSync(DOWNLOADS).filter((name) => name.startsWith('Other Game')), []);
});

test('a refusal from the service is the download failing, in its words', async (t) => {
  t.mock.method(api, 'bypass_link', async () => { throw new Error('this link has run out - ask for the file again'); });
  bypass.start('5002');
  assert.deepEqual(await settled('5002'), { state: 'failed', percent: 0, file: null, error: 'this link has run out - ask for the file again' });
});

test('only a listed game can be downloaded', () => {
  assert.throws(() => bypass.start('../5003'), { status: 400 });
  assert.throws(() => bypass.start('5009'), { status: 404 });
});

test('show in folder selects the file in Explorer, and only a file that is still there', (t) => {
  const calls = [];
  t.mock.method(child, 'execFile', (file, args, options) => { calls.push([file, args, options.windowsVerbatimArguments]); });
  const file = path.join(DOWNLOADS, 'Half-Life Alyx bypass.zip');
  assert.deepEqual(bypass.show('5001'), { shown: file });
  assert.deepEqual(calls, [['explorer.exe', [`/select,"${file}"`], true]]);
  fs.rmSync(file);
  assert.throws(() => bypass.show('5001'), { status: 404 });
  assert.throws(() => bypass.show('5002'), { status: 404 }, 'a failed download has nothing to show');
});
