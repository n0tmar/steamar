'use strict';

// A name is looked up by app id and cached in a file named after the id, and the id arrives in the
// query string of GET /api/names, which any page open in the browser can fire at 127.0.0.1. A
// lookup for "../../../config/steam" used to fail at the store and then write its "not an app"
// note over the file it had walked to, here config/steam.json, which holds the key every reply is
// checked against: the app came back up with nothing to trust.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// out/ sits beside config/ in the real tree, so three folders up from out/cache/names is the root.
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'stm-app-catalog-'));
process.env.STEAMAR_OUT = path.join(ROOT, 'out');
const VICTIM = path.join(ROOT, 'config', 'steam.json');
const KEPT = '{"api":{"public_key":"kept"}}';

const calls = [];
globalThis.fetch = async (url) => {
  calls.push(String(url));
  throw new Error('offline');
};

const catalog = require('../src/catalog');

const reset = () => {
  fs.mkdirSync(path.dirname(VICTIM), { recursive: true });
  fs.writeFileSync(VICTIM, KEPT, 'utf8');
  calls.length = 0;
};

const NOT_AN_ID = [
  '../../../config/steam',
  '..\\..\\..\\config\\steam',
  '620/../../../../config/steam',
  '1e3',
  '0x10',
  ' 12',
  '12\n',
  '1234567890123',
  '',
];

test('a name lookup cannot walk out of its cache folder, and asks nothing for an id that is not digits', async () => {
  reset();
  for (const id of NOT_AN_ID) {
    assert.equal(await catalog.app_lookup(id), null, JSON.stringify(id));
    assert.equal(await catalog.app_name(id), null, JSON.stringify(id));
  }
  assert.equal(fs.readFileSync(VICTIM, 'utf8'), KEPT, 'config/steam.json is untouched');
  assert.deepEqual(calls, [], 'no request went out for any of them');
});

test('a real id is still looked up and remembered', async () => {
  reset();
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return { ok: true, json: async () => ({ 620: { success: true, data: { name: 'Portal 2', header_image: 'https://x/h.jpg', type: 'game' } } }) };
  };
  try {
    assert.deepEqual(await catalog.app_lookup('620'), { appid: '620', name: 'Portal 2', image: 'https://x/h.jpg', type: 'game' });
    assert.equal(calls.length, 1);
    assert.equal((await catalog.app_lookup('620')).name, 'Portal 2');
    assert.equal(calls.length, 1, 'the second answer comes from the cache file');
    assert.ok(fs.existsSync(path.join(ROOT, 'out', 'cache', 'names', '620.json')));
  } finally {
    globalThis.fetch = original;
  }
});

test('a package is only resolved for an id that is digits', async () => {
  reset();
  for (const id of NOT_AN_ID) {
    await assert.rejects(catalog.resolve_package(id), (err) => err.status === 400, JSON.stringify(id));
  }
  assert.deepEqual(calls, [], 'the service and the mirror were never asked');
  assert.equal(fs.readFileSync(VICTIM, 'utf8'), KEPT);
});

test('a game is called removed from Steam only when Steam\'s own record says it is unlisted', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ response: { store_items: [
    { appid: 1399780, name: 'Spellbreak', unlisted: true },
    { appid: 339340, name: 'Resident Evil 0' },
  ] } }) });
  try {
    assert.deepEqual([...await catalog.removed_from_store(['1399780', '339340', '../x'])], ['1399780']);
    globalThis.fetch = async () => { throw new Error('offline'); };
    assert.deepEqual([...await catalog.removed_from_store(['1399780'])], [], 'a store that does not answer names none');
  } finally {
    globalThis.fetch = original;
  }
});
