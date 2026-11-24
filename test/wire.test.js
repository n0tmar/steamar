'use strict';

// The page and the engine are two programs that must agree, and nothing checked that they did. A
// settings control was calling /api/text-size for weeks while the engine had no such route: the
// only thing that kept it working was a catch block, and the only trace was a 404 in the log. This
// test reads both and fails when the page asks for something nobody answers.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const here = path.resolve(__dirname, '..');
const ui = require('../tools/dom').page_source(path.join(here, 'ui'));
const engine = fs.readFileSync(path.join(here, 'src', 'routes.js'), 'utf8');

// Routes the shell answers itself, over postMessage, before the engine is ever asked. They have no
// engine twin on purpose: the WebView belongs to a process the engine does not own.
const SHELL_ONLY = new Set(['/api/text-size']);

const called = () => [...new Set([...ui.matchAll(/api\('(\/api\/[a-z\-/]+)'/g)].map((m) => m[1]))].sort();
const answered = () => new Set([...engine.matchAll(/'[A-Z]+ (\/api\/[a-z\-/]+)'/g)].map((m) => m[1]));

test('every route the page calls is answered by the engine, or named as the shell\'s', () => {
  const routes = answered();
  const missing = called().filter((route) => !routes.has(route) && !SHELL_ONLY.has(route));
  assert.deepEqual(missing, [], 'a call with no answer is a control that does nothing');
});

test('the shell-only list holds no route the engine already answers', () => {
  const routes = answered();
  for (const route of SHELL_ONLY) {
    assert.equal(routes.has(route), false, `${route} is answered twice, so one of the two is dead`);
  }
});

test('the page still calls something, so this test cannot pass on an empty read', () => {
  assert.ok(called().length >= 20, `read ${called().length} routes from the page`);
  assert.ok(answered().size >= 20, `read ${answered().size} routes from src/routes.js`);
});

test('a text-size call sits behind the bridge, because the engine has no zoom to set', () => {
  const at = ui.indexOf("api('/api/text-size'");
  assert.ok(at > 0, 'the settings slider still offers a size');
  const before = ui.slice(Math.max(0, at - 400), at);
  assert.match(before, /if \(!bridge\)/, 'the browser path returns before the call, so it never 404s');
});
