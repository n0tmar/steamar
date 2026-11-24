'use strict';

// The Fixes tab's data: the mirror of the service's release index, what a click taught this machine, and
// what is on disk. The tab says "installed", "broken", "in your library" or "conflict" from these three
// together, and a wrong word here is a person told their game is fixed when it is not.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'stm-app-onlinefix-'));
const OUT = path.join(ROOT, 'out');
const STEAM = path.join(ROOT, 'steam');
process.env.STEAMAR_OUT = OUT;
process.env.STEAM_ROOT = STEAM;

globalThis.fetch = async () => { throw new Error('offline'); }; // the trending chart is not what is under test

const onlinefix = require('../src/onlinefix');

const write = (file, text = '') => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
};
const MIRROR = path.join(OUT, 'api', 'fixes.json');
const FLAGS = path.join(OUT, 'api', 'fix-flags.json');
const NOW = new Date().toISOString();

const ITEMS = [
  { id: 1, title: 'Alpha Game', appid: '111' },
  { id: 2, title: 'Bravo', appid: '222' },
  { id: 3, title: 'Charlie: The Return', appid: '333' },
  { id: 4, title: 'Delta Force', appid: '444' },
  { id: 5, title: 'Echo', appid: '555' },
  { id: 6, title: 'Foxtrot Alpha', appid: '666', has_fix: false },
];

test('names are compared without case, spaces or punctuation', () => {
  assert.equal(onlinefix.norm('Half-Life 2: Episode One!'), 'halflife2episodeone');
  assert.equal(onlinefix.norm(null), '');
});

test('the tab reads the mirror, and a mirror that will not parse says so instead of showing an empty shelf quietly', () => {
  write(MIRROR, '{"body": {"items": [');
  const broken = onlinefix.load();
  assert.equal(broken.total, 0);
  assert.match(broken.error, /did not parse/);

  write(MIRROR, JSON.stringify({ ts: 1, body: { fetched: NOW, items: ITEMS } }));
  // Same size is not the same file: the cache is keyed on the modified time, so make sure it moved.
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(MIRROR, later, later);
  const good = onlinefix.load();
  assert.equal(good.total, 6);
  assert.equal(good.error, undefined);
  assert.equal(onlinefix.stale(), false);
  assert.equal(onlinefix.find('3').title, 'Charlie: The Return');
  assert.equal(onlinefix.by_appid(444).title, 'Delta Force');
  assert.equal(onlinefix.find(99), null);
});

test('a search puts a title that starts with the words ahead of one that only contains them', () => {
  const titles = (term) => onlinefix.search(term).map((i) => i.title);
  assert.deepEqual(titles('alpha'), ['Alpha Game', 'Foxtrot Alpha']);
  assert.deepEqual(titles('  CHARLIE the return '), ['Charlie: The Return']);
  assert.deepEqual(titles('zulu'), []);
  assert.equal(onlinefix.search('', 3).length, 3, 'no words is the first few, not nothing');
});

test('only a good click is remembered, and what is remembered survives a refresh of the mirror', () => {
  assert.equal(onlinefix.remember(1, null), false);
  assert.equal(onlinefix.remember(1, { name: 'x' }), false, 'no link, nothing learned');
  assert.equal(onlinefix.remember(999, { url: 'https://host.example/f.zip' }), false, 'a release this index does not know');
  assert.equal(fs.existsSync(FLAGS), false);

  assert.equal(onlinefix.remember(2, { url: 'https://host.example/bravo-fix.zip', name: 'bravo-fix.zip' }), true);
  const flags = JSON.parse(fs.readFileSync(FLAGS, 'utf8'));
  assert.equal(flags['2'].has_fix, true);
  assert.equal(flags['2'].fix_url, 'https://host.example/bravo-fix.zip');
  assert.equal(flags['2'].fix_file, 'bravo-fix.zip');
  assert.equal(onlinefix.find(2).fix_file, 'bravo-fix.zip', 'the next read already carries it');

  // The service sends a new index: the judgement made on this machine is still there.
  write(MIRROR, JSON.stringify({ ts: 2, body: { fetched: NOW, items: ITEMS } }));
  const later = new Date(Date.now() + 10000);
  fs.utimesSync(MIRROR, later, later);
  assert.equal(onlinefix.find(2).fix_url, 'https://host.example/bravo-fix.zip');
});

test('each release is called what is true of it: installed, broken, in the library, in conflict, or available', () => {
  const game = (name, files) => {
    for (const [file, text] of Object.entries(files)) write(path.join(STEAM, 'steamapps', 'common', name, file), text);
  };
  game('Alpha Game', { 'OnlineFix.ini': '[Main]\nRealAppId=111\n', 'steam_api64.dll': 'dll' });   // fix + the api dll: installed
  game('Bravo', { 'OnlineFix.ini': '[Main]\nRealAppId=222\n' });                                  // fix, no api dll: broken
  game('Delta Force', { 'OnlineFix.ini': '[Main]\nRealAppId=444\n', 'steam_api64.dll': 'dll' });  // fix on disk...
  write(path.join(STEAM, 'config', 'stplug-in', '333.lua'), 'addappid(333)\n');                   // library only
  write(path.join(STEAM, 'config', 'stplug-in', '444.lua'), 'addappid(444)\n');                   // ...and in the library too: conflict

  const view = onlinefix.view();
  const state = Object.fromEntries(view.rows.map((r) => [r.title, r.state]));
  assert.deepEqual(state, {
    'Alpha Game': 'installed',
    Bravo: 'broken',
    'Charlie: The Return': 'library',
    'Delta Force': 'conflict',
    Echo: 'available',
  });
  assert.equal(view.total, 5, 'a page that offers no fix of its own is not on the tab');
  assert.equal(view.hidden, 1);
  assert.equal(view.installed, 3, 'three folders carry a fix');
  assert.deepEqual(view.counts, { installed: 1, broken: 1, library: 1, conflict: 1, available: 1 });
  assert.equal(view.rows.find((r) => r.title === 'Echo').image, '/img/555.jpg');
});
