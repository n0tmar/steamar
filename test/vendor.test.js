'use strict';

// The one download routine the helper files and the update both use. A mirror is somebody else's
// server: what it answers must not be able to stop the engine. https.get throws on an address that is
// not https, and it did so from inside a response callback, so a redirect to http:// was an uncaught
// exception and the whole process exited in the middle of somebody's session.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');

const vendor = require('../src/vendor');

const TARGET = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'stm-vendor-')), 'file.bin');

// A mirror that is a table: address -> what it answers. Anything else goes to the real https.get,
// which is what makes a non-https hop throw exactly as it does in production.
const real_get = https.get;
function mirror(table) {
  https.get = (url, options, callback) => {
    const answer = table[String(url)];
    if (!answer) return real_get(url, options, callback);
    const res = answer.body === undefined
      ? Object.assign(new EventEmitter(), { statusCode: answer.status, headers: { location: answer.location }, resume() {} })
      : Object.assign(Readable.from([Buffer.from(answer.body)]), { statusCode: answer.status, headers: { 'content-length': String(answer.body.length) } });
    setImmediate(() => callback(res));
    return Object.assign(new EventEmitter(), { setTimeout() {}, destroy() {} });
  };
}
test.afterEach(() => { https.get = real_get; });

test('a redirect to plain http is refused, and does not take the process down', async () => {
  mirror({ 'https://mirror.example/a.zip': { status: 302, location: 'http://elsewhere.example/a.zip' } });
  await assert.rejects(vendor.fetch_file('https://mirror.example/a.zip', TARGET), /only https/);
});

test('a redirect that is not an address is refused too', async () => {
  mirror({ 'https://mirror.example/a.zip': { status: 302, location: 'http://[bad' } });
  await assert.rejects(vendor.fetch_file('https://mirror.example/a.zip', TARGET), /not a URL/);
});

test('a first address that is not https is refused before anything is asked', async () => {
  await assert.rejects(vendor.fetch_file('http://mirror.example/a.zip', TARGET), /only https/);
  await assert.rejects(vendor.fetch_file('file:///C:/Windows/win.ini', TARGET), /only https/);
});

test('redirects between https addresses are followed, and the bytes land on disk', async () => {
  mirror({
    'https://github.example/a.zip': { status: 302, location: 'https://objects.example/a.zip' },
    'https://objects.example/a.zip': { status: 200, body: 'hello' },
  });
  const seen = [];
  const done = await vendor.fetch_file('https://github.example/a.zip', TARGET, (got) => seen.push(got));
  assert.equal(done.bytes, 5);
  assert.equal(fs.readFileSync(TARGET, 'utf8'), 'hello');
  assert.deepEqual(seen, [5]);
});

test('a loop of redirects ends', async () => {
  mirror({ 'https://loop.example/a.zip': { status: 302, location: 'https://loop.example/a.zip' } });
  await assert.rejects(vendor.fetch_file('https://loop.example/a.zip', TARGET), /too many redirects/);
});

// The helper files run inside Steam. Only a file whose checksum config/steam.json names is trusted.
const SHIPPED = path.join(__dirname, '..', 'vendor');
const DLLS = ['dwmapi.dll', 'xinput1_4.dll', 'OpenSteamTool.dll'];
// The public repository leaves them out: a copy built from it downloads them at setup instead.
const shipped = DLLS.every((name) => fs.existsSync(path.join(SHIPPED, name)));

test('the helper files the app ships match their checksums, so a fresh copy needs no download', { skip: !shipped && 'the helper DLLs are not in this copy' }, () => {
  for (const name of DLLS) {
    assert.equal(vendor.is_known(name, path.join(SHIPPED, name)), true, name);
  }
  assert.equal(vendor.is_known('DWMAPI.DLL', path.join(SHIPPED, 'dwmapi.dll')), true, 'names match the way Windows matches them');
});

test('any other helper file is refused', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stm-pins-'));
  fs.writeFileSync(path.join(dir, 'dwmapi.dll'), 'not the real file');
  assert.equal(vendor.is_known('dwmapi.dll', path.join(dir, 'dwmapi.dll')), false, 'a file with the right name and the wrong bytes');
  assert.equal(vendor.is_known('xinput1_4.dll', path.join(SHIPPED, 'dwmapi.dll')), false, 'a real file under another name');
  assert.equal(vendor.is_known('dwmapi.dll', path.join(dir, 'missing.dll')), false, 'a file that is not there');
  assert.equal(vendor.is_known('dwmapi.dll', path.join(SHIPPED, 'dwmapi.dll'), [{ name: 'unpinned' }]), false, 'a source that names no checksums');
});
