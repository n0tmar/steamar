'use strict';

// A DOM small enough to hold one renderer, shared by the checks that render the page without a
// browser: every element asked for by id is a stub that remembers what was written into it.
// It also lists index.html's scripts and stylesheets in order. It cannot show load order;
// test/page.test.js checks that. Trap: `nodes` is one Map for the process, so an id keeps what an
// earlier check wrote until something clears it.

const fs = require('node:fs');
const path = require('node:path');

// The page's scripts, named by index.html in the order it loads them.
function page_scripts(ui_dir) {
  const html = fs.readFileSync(path.join(ui_dir, 'index.html'), 'utf8');
  const files = [...html.matchAll(/<script src="\/([\w-]+\.js)"/g)].map((m) => m[1]);
  if (!files.length) throw new Error('index.html names no scripts');
  return files;
}

// The page as the checks run it: every script, in that order, as one source. One function body is one
// scope, which is what classic scripts on a page share. What it cannot show is load order - code that
// runs while a file loads may only use what that file or an earlier one declared - so that is
// test/page.test.js's job.
const page_source = (ui_dir) => page_scripts(ui_dir)
  .map((name) => fs.readFileSync(path.join(ui_dir, name), 'utf8'))
  .join('\n;\n');

// The stylesheets index.html links, in order, and all of them as one text for a check that greps rules.
function page_styles(ui_dir) {
  const html = fs.readFileSync(path.join(ui_dir, 'index.html'), 'utf8');
  const files = [...html.matchAll(/<link rel="stylesheet" href="\/([\w-]+\.css)">/g)].map((m) => m[1]);
  if (!files.length) throw new Error('index.html links no stylesheets');
  return files;
}

const page_css = (ui_dir) => page_styles(ui_dir)
  .map((name) => fs.readFileSync(path.join(ui_dir, name), 'utf8'))
  .join('\n');

const nodes = new Map();

function node(id) {
  if (nodes.has(id)) return nodes.get(id);
  const element = {
    id,
    hidden: false,
    inert: false,
    disabled: false,
    innerHTML: '',
    textContent: '',
    value: '',
    title: '',
    dataset: {},
    style: {},
    classList: {
      set: new Set(),
      add(name) { this.set.add(name); },
      remove(name) { this.set.delete(name); },
      contains(name) { return this.set.has(name); },
      toggle(name, on) { if (on === false) this.set.delete(name); else this.set.add(name); },
    },
    addEventListener() {},
    removeAttribute() {},
    setAttribute() {},
    getAttribute() { return null; },
    // An element finds its own children by the selector it asked for: a body written into
    // `.dbody` is a node here, which is what lets a check read what the panel actually said.
    querySelector(selector) { return node(selector); },
    querySelectorAll() { return []; },
    closest() { return null; },
    appendChild() {},
    // What a renderer adds beside an element, kept on the element so a check can read it.
    insertAdjacentHTML(where, html) { this.adjacent = (this.adjacent || '') + html; },
    remove() {},
    focus() {},
    select() {},
  };
  nodes.set(id, element);
  return element;
}

const document = {
  getElementById: node,
  querySelector: () => null,
  querySelectorAll: () => [],
  // The window's own listeners are irrelevant here: these checks call the renderers directly.
  addEventListener() {},
  createElement: () => node('created'),
  contains: () => false,
  hidden: false,
  activeElement: null,
  documentElement: node('html'),
  body: node('body'),
};

// One clean window per check: whatever the last case drew must not pass for this one.
function window_stub(extra = {}) {
  return {
    addEventListener() {},
    removeEventListener() {},
    matchMedia: () => ({ matches: false }),
    open() {},
    chrome: null,
    ...extra,
  };
}

const noop_timer = () => 0;

module.exports = { node, nodes, document, window_stub, noop_timer, page_scripts, page_source, page_styles, page_css };
