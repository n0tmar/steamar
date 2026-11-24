'use strict';

// What the window sees without a restart. The Denuvo list and the fix index are for members, so a PC
// that signs in after the engine started was refused both at boot, and a person who just donated or
// got a role pressed "check again" and was handed the answer from before the question. The engine's
// routes are called here with the service replaced by stubs.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'stm-app-routes-'));
process.env.STEAMAR_OUT = path.join(ROOT, 'out');
process.env.STEAM_ROOT = path.join(ROOT, 'steam');
process.env.STEAMAR_API = 'http://127.0.0.1:9';
globalThis.fetch = async () => { throw new Error('offline'); }; // the trending chart is not under test

// A link the engine hands to Windows is written down here instead of opened.
const opened = [];
require('node:child_process').execFile = (file, args, ...rest) => {
  opened.push(args[args.length - 1]);
  const done = rest.find((arg) => typeof arg === 'function');
  if (done) done(null, '', '');
};
const { Readable } = require('node:stream');

const api = require('../src/api');
const mirror = require('../src/mirror');
const denuvo = require('../src/denuvo');
const onlinefix = require('../src/onlinefix');
const { routes } = require('../src/routes');

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
const refused = () => Object.assign(new Error('this PC is not linked to a member'), { code: 'link_required' });
const ask = (route, query = '') => routes[route]({ headers: {} }, new URL(`http://127.0.0.1/x${query}`));

let member = false;
let releases = [{ id: 1, title: 'Alpha Game', appid: '111' }, { id: 2, title: 'Bravo', appid: '222' }];
let account = { known: true, linked: false, tier: 'none' };
const calls = { fixes: 0, denuvo: 0 };

api.fixes = async () => {
  calls.fixes += 1;
  if (!member) throw refused();
  mirror.cache_write('fixes', { fetched: new Date().toISOString(), items: releases });
  return { items: releases };
};
api.denuvo = async () => {
  calls.denuvo += 1;
  if (!member) throw refused();
  return { titles: [{ name: 'Locked Game', appid: '999' }] };
};
api.refresh_account = async () => null;
api.state = () => ({ account, campaign: null, configured: true, enrolled: true });

test('a PC that signs in after the engine started gets the Denuvo list and the fixes without a restart', async () => {
  // Boot, signed out: the service refuses both lists.
  await Promise.allSettled([denuvo.hydrate(), onlinefix.hydrate()]);
  assert.equal(onlinefix.load().items.length, 0);
  assert.equal(denuvo.has('999'), false);

  // Still at the door: the window's polls do not keep asking for lists the service will refuse.
  await ask('GET /api/account');
  assert.deepEqual(calls, { fixes: 1, denuvo: 1 });

  // The sign-in lands. The next account question asks for both lists again.
  member = true;
  account = { known: true, linked: true, tier: 'member' };
  await ask('GET /api/account');
  assert.deepEqual(calls, { fixes: 2, denuvo: 2 });
  await tick();
  assert.equal(onlinefix.load().items.length, 2);
  assert.equal(denuvo.has('999'), true);

  // Both are here now, so the polls after this one leave them alone.
  await ask('GET /api/account');
  assert.deepEqual(calls, { fixes: 2, denuvo: 2 });
});

test('the Fixes tab asks again each time it opens, so a release added since shows up', async () => {
  const before = await ask('GET /api/fixes', '?limit=50');
  assert.equal(before.total, 2);

  releases = [...releases, { id: 3, title: 'Charlie', appid: '333' }];
  await tick(); // a new copy is a new file: make sure its modified time moves
  const after = await ask('GET /api/fixes', '?limit=50');
  assert.equal(after.total, 3);
  assert.ok(after.rows.some((row) => row.title === 'Charlie'));
});

test('"check again" waits for the fresh answer instead of handing back the one from before', async () => {
  account = { known: true, linked: true, tier: 'member' };
  api.refresh_account = () => new Promise((resolve) => setTimeout(() => {
    account = { known: true, linked: true, tier: 'donor' };
    resolve(account);
  }, 30));

  const quick = await ask('GET /api/account');
  assert.equal(quick.account.tier, 'member', 'a plain poll answers at once with what the engine has');
  await tick();
  await tick();

  account = { known: true, linked: true, tier: 'member' };
  const checked = await ask('GET /api/account', '?force=1');
  assert.equal(checked.account.tier, 'donor');
});

test('Home is the owner\'s eighty games in six shelves, and the picks lead the banner', async () => {
  const catalog = require('../src/catalog');
  const images = require('../src/images');
  images.hero_available = async () => true;
  // The service's index can name a game in another language; the store's English name wins.
  catalog.app_lookup = async (id) => (id === '1091500' ? { appid: id, name: 'Cyberpunk 2077' } : null);
  api.account_view = () => ({ home: { picks: [{ appid: '1091500', name: '赛博朋克 2077' }, { appid: '../x', name: 'not an id' }, { appid: '20', name: 'New' }] } });

  const store = await ask('GET /api/store');
  assert.deepEqual(store.shelves.map((s) => s.games.length), [15, 15, 15, 10, 10, 15], 'six shelves');
  const ids = store.shelves.flatMap((s) => s.games.map((g) => g.appid));
  assert.equal(new Set(ids).size, 80, 'eighty games, none twice');
  assert.ok(ids.every((id) => /^\d+$/.test(id)));
  assert.equal(store.shelves[0].games[0].image, '/img/3240220.jpg');
  assert.deepEqual(store.picks.map((p) => p.appid), ['1091500', '20'], 'an id that is not one is dropped');
  assert.equal(store.picks[0].name, 'Cyberpunk 2077', 'the store name replaces the index name');
  assert.equal(store.picks[1].name, 'New', 'a game the store does not know keeps the name it came with');
  assert.deepEqual(store.banner.map((b) => b.appid), ['1091500', '20', '3240220', '1174180'], 'picks first, then the shelves, and no game twice');

  // More than four picks: every one gets a slide, in the owner's order.
  const many = ['31', '32', '33', '34', '35', '36'].map((appid) => ({ appid, name: `Pick ${appid}` }));
  api.account_view = () => ({ home: { picks: many } });
  const wide = await ask('GET /api/store');
  assert.deepEqual(wide.banner.map((b) => b.appid), ['31', '32', '33', '34', '35', '36'], 'six picks are six slides');

  api.account_view = () => ({ home: null });
  const plain = await ask('GET /api/store');
  assert.deepEqual(plain.picks, []);
  assert.deepEqual(plain.banner.map((b) => b.appid), ['3240220', '1174180', '1245620', '1086940'], 'with no picks, the head of each shelf');
});

test('the profile buttons open the public page and its editor in the browser, for a signed-in person only', async () => {
  process.env.STEAMAR_SITE = 'https://steamar.cc';
  const post = (body) => routes['POST /api/profile'](Readable.from([Buffer.from(JSON.stringify(body))]), new URL('http://127.0.0.1/x'));
  api.account_view = () => ({ linked: true, tier: 'member', user: { username: 'player.one' } });
  assert.equal((await post({})).opened, 'https://steamar.cc/@player.one');
  assert.equal((await post({ edit: true })).opened, 'https://steamar.cc/account/profile');
  assert.deepEqual(opened.slice(-2), ['https://steamar.cc/@player.one', 'https://steamar.cc/account/profile'], 'and both reach the browser');

  // A bought name is the page's address, and a connection opens by its place in the person's list.
  const links = [{ kind: 'github', url: 'https://github.com/k' }, { kind: 'x', url: 'file:///C:/Windows/system32/calc.exe' }];
  api.account_view = () => ({ linked: true, tier: 'member', user: { username: 'player.one' }, profile: { url: 'https://steamar.cc/@k', links } });
  assert.equal((await post({})).opened, 'https://steamar.cc/@k');
  assert.equal((await post({ link: 0 })).opened, 'https://github.com/k');
  await assert.rejects(post({ link: 1 }), /not a link we can open/, 'only https reaches the browser');
  await assert.rejects(post({ link: 2 }), /not on your page any more/);
  await assert.rejects(post({ link: 'https://evil.test/' }), /not on your page any more/, 'an address from the window is not a place in the list');
  assert.equal(opened.at(-1), 'https://github.com/k', 'nothing refused was opened');
  api.account_view = () => ({ linked: false, user: null });
  await assert.rejects(post({}), /Sign in first/);
  delete process.env.STEAMAR_SITE;
});

test('Sign out asks the service to forget this PC and answers with the account it now has', async () => {
  let asked = 0;
  api.sign_out = async () => { asked += 1; };
  const was = api.state;
  api.state = () => ({ account: { known: true, linked: false, tier: 'none' } });
  const answer = await ask('POST /api/logout');
  assert.equal(asked, 1);
  assert.equal(answer.account.linked, false, 'the window can draw the sign-in screen from this answer');
  api.state = was;
});
