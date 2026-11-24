'use strict';

// The page is a set of classic scripts that share one global scope, loaded in the order index.html
// names them. A function a file declares exists only once that file has run, so code that runs while
// a file loads may only use what that file or an earlier one declared. The view checks join the files
// into one source and cannot see that; this loads them the way a browser does, one script at a time in
// one shared realm, and fails on the first name used before it exists.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const dom = require('../tools/dom');

const UI = path.join(__dirname, '..', 'ui');
const storage = { getItem: () => null, setItem() {}, removeItem() {} };

test('every script in ui/ is loaded by index.html, once', () => {
  const loaded = dom.page_scripts(UI);
  const on_disk = fs.readdirSync(UI).filter((name) => name.endsWith('.js'));
  assert.deepEqual([...loaded].sort(), [...on_disk].sort(), 'a file nobody loads is dead, and a name with no file is a 404');
  assert.equal(new Set(loaded).size, loaded.length, 'a file loaded twice declares everything twice');
});

test('every stylesheet in ui/ is linked by index.html, once', () => {
  const linked = dom.page_styles(UI);
  const on_disk = fs.readdirSync(UI).filter((name) => name.endsWith('.css'));
  assert.deepEqual([...linked].sort(), [...new Set(linked)].sort(), 'a stylesheet linked twice applies twice');
  assert.deepEqual([...linked].sort(), on_disk.sort(), 'a stylesheet on disk that is not linked styles nothing');
});

test('the page loads one script at a time, in order, without using a name before it exists', async () => {
  const asked = [];
  const escaped = [];
  const on_rejection = (err) => escaped.push(err);
  process.on('unhandledRejection', on_rejection);
  const context = vm.createContext({
    window: dom.window_stub(),
    document: dom.document,
    // Boot asks the engine first; an answer that never comes keeps it waiting instead of drawing.
    fetch: (url) => { asked.push(String(url)); return new Promise(() => {}); },
    navigator: { userAgent: 'steamar-page-test' },
    location: { hash: '#/home', href: 'http://127.0.0.1:8788/index.html' },
    sessionStorage: storage,
    localStorage: storage,
    setTimeout: dom.noop_timer,
    setInterval: dom.noop_timer,
    clearTimeout() {},
    clearInterval() {},
    // What a browser has that a fresh realm does not.
    console,
    URL,
    URLSearchParams,
    AbortController,
    AbortSignal,
    TextEncoder,
    TextDecoder,
    queueMicrotask,
  });
  for (const name of dom.page_scripts(UI)) {
    assert.doesNotThrow(
      () => vm.runInContext(fs.readFileSync(path.join(UI, name), 'utf8'), context, { filename: `ui/${name}` }),
      `ui/${name} reached for something that is not there yet`,
    );
    // A browser lets pending promises run between two scripts; so does this, or a failure that
    // surfaces one step later would find the next file already loaded and pass.
    await new Promise((resolve) => setImmediate(resolve));
  }
  // The last file starts the page, so by then every renderer must exist.
  for (const name of ['boot', 'route', 'render_home', 'render_fixes', 'open_drawer', 'handle_act']) {
    assert.equal(vm.runInContext(`typeof ${name}`, context), 'function', name);
  }

  // Boot runs as the last file loads and fails quietly if it starts too early: its first step is to
  // ask the engine who is signed in. That question being asked is the proof it got that far.
  await new Promise((resolve) => setImmediate(resolve));
  process.off('unhandledRejection', on_rejection);
  assert.deepEqual(escaped.map((err) => String(err && err.message)), [], 'boot threw while the page loaded');
  assert.equal(asked[0], '/api/account', `boot's first question is who is signed in (asked: ${asked.join(', ') || 'nothing'})`);
});
