'use strict';

// The client's memory of the service: what counts as contact, what counts as an outage, and what a
// mirror is allowed to answer. Every case here is a bug that shipped: a cache hit reported as a live
// reply, a failed call that nothing recorded, and a pin that kept verifying against the old key.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// A throwaway out/: this test writes device.key, device.json and the mirrors.
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'stm-app-api-'));
process.env.STEAMAR_OUT = OUT;
process.env.STEAMAR_API = 'http://service.test';
process.env.STEAMAR_SITE = 'http://site.test';

const server = crypto.generateKeyPairSync('ed25519');
const server_pub = server.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
process.env.STEAMAR_API_KEY = server_pub;

const api = require('../src/api');
const { canonical, sha256_hex } = require('../src/device');

// A new process, for the tests that need one: the client is five modules, and each keeps its own memory.
const CLIENT = ['api', 'account', 'transport', 'mirror', 'device'];
const forget_modules = () => { for (const name of CLIENT) delete require.cache[require.resolve(`../src/${name}`)]; };
const { version: APP_VERSION } = require('../package.json');

/* ---------- a service that answers like the real one ---------- */

let mode = 'ok';      // ok | down | unknown_app
let signed_with = server.privateKey;
let calls = 0;
let me_calls = 0;
// The floor the service says it serves. Null is the normal day; a version string is a 426 on every
// data route, reported by /v1/me.
let me_floor = null;
// How long ago the service signed what it answers. Zero is a live reply.
let reply_age_ms = 0;

const reply = (status, payload) => new Response(JSON.stringify(payload), {
  status,
  headers: { 'content-type': 'application/json' },
});

function envelope(device, body) {
  const core = { v: 1, ts: Date.now() - reply_age_ms, device, body };
  const sig = crypto.sign(null, Buffer.from(sha256_hex(canonical(core))), signed_with).toString('base64');
  return { ...core, sig };
}

// The app's transport is one module, so a test stubs it rather than the global: this is the pool every
// call goes through, and intercepting anything else would be testing a client the app does not use.
let last_headers = null;
require('../src/net').fetch = async (url, init) => {
  calls += 1;
  last_headers = (init && init.headers) || null;
  const route = new URL(url).pathname;

  if (route === '/v1/enroll') {
    if (mode === 'down') throw new TypeError('fetch failed');
    return reply(200, { body: { device_id: 'dev_test000000000000', token: 'token-value', server_key: server_pub } });
  }
  if (mode === 'down') throw new TypeError('fetch failed');
  if (mode === 'unknown_app') return reply(404, { error: { code: 'unknown_app', message: 'no data for app 42' } });

  // Who is on this PC, as the real service answers it: the profile, the role, the month.
  if (route === '/v1/me') {
    me_calls += 1;
    return reply(200, envelope('dev_test000000000000', {
      device_id: 'dev_test000000000000',
      linked: true,
      tier: 'member',
      user: { username: 'maro', global_name: 'Maro', avatar_url: 'https://cdn.test/a.png' },
      profile: {
        path: '/@maro', owner: false, hidden: false,
        background: { image_url: '/v1/profile/image?f=aaaaaaaaaaaaaaaaaaaaaaaa.jpg' }, banner: { image_url: '/v1/profile/image?f=bbbbbbbbbbbbbbbbbbbbbbbb.jpg' },
        frame: 'heartbloom', bio: 'hi there', links: [{ kind: 'github', url: 'https://github.com/maro' }],
        pronouns: 'he/him', status: { kind: 'dnd', text: 'in a raid' },
      },
      pass: { active: false },
      paused: null,
      campaign: { percent: 100 },
      gate: true,
      // The floor, as the service reports it on the one route it never enforces it.
      min_app_version: me_floor || '0.4.0',
      update_required: Boolean(me_floor),
    }));
  }

  return reply(200, envelope('dev_test000000000000', {
    addable: 11, supplier_titles: 10, depot_keys: 99, tokens: 3, denuvo_titles: 1, fixes: 4,
  }));
};

const reset = () => { mode = 'ok'; signed_with = server.privateKey; me_floor = null; reply_age_ms = 0; api.reset(); };

/* ---------- what counts as an answer ---------- */

test('a verified reply is contact, and the mirror is not', async () => {
  reset();
  const before = calls;
  const counts = await api.reach();
  assert.equal(counts.addable, 11);
  assert.equal(calls, before + 2, 'one enrollment, one reach');
  const live_at = api.state().last_ok;
  assert.ok(live_at, 'a verified reply sets last_ok');
  assert.equal(api.state().last_error, null);

  // Second read inside the TTL comes out of the mirror. It must not look like a fresh answer.
  const again = await api.reach();
  assert.equal(again.addable, 11);
  assert.equal(calls, before + 2, 'the mirror answered without a request');
  assert.equal(api.state().last_ok, live_at, 'a mirror read does not move "last answered"');
});

test('a failed call is recorded, and the next good one clears it', async () => {
  reset();
  await api.reach();
  assert.equal(api.state().last_error, null);

  mode = 'down';
  api.reset(); // no mirror to fall back on, so the call has to fail
  await assert.rejects(() => api.reach(), (err) => {
    assert.equal(err.code, 'unreachable');
    return true;
  });
  const failed = api.state().last_error;
  assert.equal(failed.code, 'unreachable');

  mode = 'ok';
  await api.reach();
  assert.equal(api.state().last_error, null, 'recovery clears the error');
  assert.ok(api.state().last_ok);
});

test('an app the service does not cover is not an outage', async () => {
  reset();
  await api.reach();
  const good = api.state().last_ok;

  mode = 'unknown_app';
  await assert.rejects(() => api.package_for(42), (err) => err.code === 'unknown_app');
  assert.equal(api.state().last_error, null, 'a 404 answer is still an answer');
  assert.equal(api.state().last_ok, good);
});

test('a reply signed by another key is refused', async () => {
  reset();
  await api.reach();

  // The pin stays the real server; someone else answers in its place.
  const impostor = crypto.generateKeyPairSync('ed25519');
  signed_with = impostor.privateKey;
  api.reset(); // drop the mirror, so this is a real request that really must be refused
  await assert.rejects(() => api.reach(), (err) => {
    assert.ok(['bad_reply_signature', 'bad_reply'].includes(err.code), `got ${err.code}`);
    return true;
  });
  signed_with = server.privateKey;
});

test('a reply signed long ago is refused, so an old answer cannot be played back', async () => {
  const minutes = (n) => n * 60 * 1000;

  // Last month's /v1/me is signed by the right key for the right device, and says nothing is paused.
  reply_age_ms = minutes(11);
  api.reset();
  await assert.rejects(() => api.reach(), (err) => err.code === 'stale_reply');

  // A clock a long way ahead is no more an answer to this call than one a long way behind.
  reply_age_ms = -minutes(11);
  api.reset();
  await assert.rejects(() => api.reach(), (err) => err.code === 'stale_reply');

  // What a slow network does to a genuine reply is nowhere near that.
  reply_age_ms = minutes(9);
  api.reset();
  assert.equal((await api.reach()).addable, 11);
  reply_age_ms = 0;
});

test('rotating the pin throws away every mirrored answer', async () => {
  reset();
  await api.reach();
  const cached_under_old_pin = calls;

  // Same server, a new pin: the mirror belongs to the old key and must not be read.
  const next = crypto.generateKeyPairSync('ed25519');
  const next_pub = next.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  assert.equal(next_pub.slice(0, 16), server_pub.slice(0, 16), 'the old tag could not tell these apart');

  process.env.STEAMAR_API_KEY = next_pub;
  signed_with = next.privateKey;
  const counts = await api.reach();
  assert.equal(counts.addable, 11);
  assert.ok(calls > cached_under_old_pin, 'the stale mirror was ignored and a request went out');

  process.env.STEAMAR_API_KEY = server_pub;
  signed_with = server.privateKey;
  api.reset();
});

test('the device identity lives under STEAMAR_OUT and names its server', async () => {
  reset();
  await api.reach();
  assert.ok(fs.existsSync(path.join(OUT, 'device.key')), 'the key is written where the test pointed');
  assert.ok(fs.existsSync(path.join(OUT, 'device.json')));
  const saved = JSON.parse(fs.readFileSync(path.join(OUT, 'device.json'), 'utf8'));
  assert.equal(saved.base, 'http://service.test');
  assert.equal(saved.device_id, 'dev_test000000000000');
});

/* ---------- who is on this PC ---------- */

// The first screen of the app hangs on one question, and until this pass nothing asked it: the
// account view only ever filled in after somebody signed in, so a signed-in machine still booted as
// a stranger and a fresh install never saw a door.

test('who is on this PC is asked once, and the answer is kept', async () => {
  reset();
  const before = me_calls;
  const first = await api.refresh_account({ force: true });
  assert.equal(first.linked, true);
  assert.equal(me_calls, before + 1, 'one identity call, not a poll');
  assert.equal(api.account_view().source, 'live');
  assert.equal(api.account_view().user.username, 'maro');
  assert.equal(api.account_view().gate, true);
  // The page arrives on the site's address, and its pictures through the engine's /img/site/.
  assert.deepEqual(api.account_view().profile, {
    url: 'http://site.test/@maro',
    handle: 'maro',
    hidden: false,
    owner: false,
    background: { image_url: '/img/site/profile/aaaaaaaaaaaaaaaaaaaaaaaa.jpg' },
    banner: { image_url: '/img/site/profile/bbbbbbbbbbbbbbbbbbbbbbbb.jpg' },
    frame: 'heartbloom',
    frame_url: '/img/site/frames/heartbloom.gif',
    marks: { owner: '/img/site/badges/448267-droolingcatking.png', donor: '/img/site/badges/95458-heart.gif' },
    bio: 'hi there',
    links: [{ kind: 'github', url: 'https://github.com/maro' }],
    pronouns: 'he/him',
    status: { kind: 'dnd', text: 'in a raid' },
  });

  await api.refresh_account();
  assert.equal(me_calls, before + 1, 'a second ask inside the minute reuses the answer');

  // Kept on disk as well, because the question is asked before the network is known to work.
  const saved = JSON.parse(fs.readFileSync(path.join(OUT, 'api', 'account.json'), 'utf8'));
  assert.equal(saved.body.known, true);
  assert.equal(saved.body.linked, true);
});

test('a start with no network still knows who was signed in', async () => {
  reset();
  await api.refresh_account({ force: true });
  assert.equal(api.account_view().source, 'live');
  mode = 'down';

  // A new process: same out/, same pin, nothing in memory.
  forget_modules();
  const fresh = require('../src/api');
  const view = fresh.account_view();
  assert.equal(view.known, true);
  assert.equal(view.linked, true);
  assert.equal(view.source, 'saved', 'the answer came from disk, and says so');
  assert.equal(view.user.username, 'maro');
  assert.equal(fresh.state().account.linked, true, 'so the app opens instead of the door');
  forget_modules();
});

test('a PC that never answered says nobody, instead of inventing a person', async () => {
  reset();                 // no saved identity on disk either
  mode = 'down';

  // A new process with no memory of an earlier answer.
  forget_modules();
  const fresh = require('../src/api');
  const answer = await fresh.refresh_account({ force: true });
  assert.equal(answer, null, 'a failed identity is null, not a thrown error');

  const view = fresh.account_view();
  assert.equal(view.known, false);
  assert.equal(view.linked, false);
  assert.equal(view.source, 'none');
  assert.equal(view.error.code, 'unreachable', 'the screen can say why it has nothing to draw');
  forget_modules();
});

/* ---------- a build the service will not serve ---------- */

// The floor is enforced on the data routes and reported on /v1/me. Without reading the report, the
// settings page says "unknown" while the shelf is empty for a reason, and the person is left to
// guess. This is the app's half of that promise.

test('a floor the service reports reaches the update row, manifest or not', async () => {
  reset();
  me_floor = '4.0.0';

  await api.refresh_account({ force: true });
  const view = api.state().update;
  assert.equal(view.state, 'required', 'the row says the build is too old, not that it is unknown');
  assert.equal(view.version, '4.0.0');
  assert.equal(view.url, null, 'no download link is invented out of a floor');
  assert.match(view.notes, /replaced/);

  // The floor judges the build that called, so the call has to say which build it is: a machine
  // updated in place keeps its device.json and never enrolls again, and the row would stay old.
  assert.equal(last_headers['x-stm-app'], APP_VERSION, 'the identity call reported the build');
  await api.report({ appid: '5001', outcome: 'ok' });
  assert.equal(last_headers['x-stm-app'], APP_VERSION, 'and so does a post');

  me_floor = null;
  await api.refresh_account({ force: true });
  assert.notEqual(api.state().update.state, 'required', 'the floor is read again on the next identity call, not remembered');
});

test.after(() => { try { fs.rmSync(OUT, { recursive: true, force: true }); } catch { /* windows lock */ } });
