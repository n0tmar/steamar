'use strict';

// The engine does four things on the desktop for the page: open a link, copy text, pick a folder and
// show a folder. Each one starts a Windows program, so each one is a place where text from the page
// could become a command. These tests replace the program starters with recorders and check that page
// text only ever travels as one argument or in an environment variable, and that anything else is
// refused before a program starts.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const child_process = require('node:child_process');

const started = [];
child_process.execFile = (file, args, options, callback) => {
  started.push({ file, args, options });
  const done = typeof options === 'function' ? options : callback;
  if (done) setImmediate(() => done(null, 'C:\\Games\n', ''));
  return {};
};
child_process.spawn = (file, args, options) => {
  started.push({ file, args, options });
  const child = new EventEmitter();
  child.stderr = new EventEmitter();
  setImmediate(() => child.emit('exit', 0));
  return child;
};

const STEAM = path.join(os.tmpdir(), `stm-app-desktop-missing-${process.pid}`);
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'stm-app-desktop-out-'));
process.env.STEAM_ROOT = STEAM;
process.env.STEAMAR_OUT = OUT;

const desktop = require('../src/desktop');

const refused = (fn, status) => assert.throws(fn, (err) => err.status === status);

test('a link is opened only when it is https, or plain http on this machine', () => {
  for (const url of [
    'file:///C:/Windows/System32/calc.exe',
    'javascript:alert(1)',
    'http://example.com/',
    'https://example.com/a b',
    'https://example.com/"&calc',
    'https://example.com/|calc',
    'https://example.com/^calc',
    '',
  ]) {
    started.length = 0;
    refused(() => desktop.open_link(url), 400);
    assert.equal(started.length, 0, `nothing starts for ${url}`);
  }

  for (const url of ['https://steamar.cc/donate', 'http://127.0.0.1:8080/admin', 'http://localhost/x']) {
    started.length = 0;
    assert.deepEqual(desktop.open_link(url), { opened: url });
    assert.equal(started[0].file, 'cmd');
    assert.deepEqual(started[0].args, ['/c', 'start', '""', url], 'the link is one argument of its own');
  }
});

test('a folder picker gets its title and start folder through the environment, never in the script', async () => {
  started.length = 0;
  const title = "Pick it'; Start-Process calc; '\u2019";
  const picked = await desktop.pick_folder(title, OUT);
  assert.equal(picked, 'C:\\Games');
  const [{ file, args, options }] = started;
  assert.equal(file, 'powershell');
  const script = args[args.length - 1];
  assert.ok(!script.includes('calc') && !script.includes(OUT), 'page text is not part of the script');
  assert.equal(options.env.STEAMAR_TITLE, title);
  assert.equal(options.env.STEAMAR_START, OUT);
});

test('text to copy travels in the environment, and empty or oversized text is refused', async () => {
  refused(() => desktop.put_clipboard(''), 400);
  refused(() => desktop.put_clipboard('x'.repeat(4097)), 400);

  started.length = 0;
  const text = '"; Remove-Item C:\\ -Recurse; "';
  assert.deepEqual(await desktop.put_clipboard(text), { copied: text.length });
  const [{ file, args, options }] = started;
  assert.equal(file, 'powershell');
  assert.ok(!args.join(' ').includes('Remove-Item'), 'the text is not part of the command');
  assert.equal(options.env.STEAMAR_CLIP, text);
});

test('only the folders the engine knows can be shown, and only when they exist', () => {
  refused(() => desktop.reveal('C:\\Windows'), 400);
  refused(() => desktop.reveal('steam'), 404);

  started.length = 0;
  assert.deepEqual(desktop.reveal('out'), { opened: OUT });
  assert.deepEqual(started[0], { file: 'explorer.exe', args: [OUT], options: undefined });

  assert.equal(desktop.folder_for('steam_root'), STEAM);
  assert.equal(desktop.folder_for('C:\\Windows'), '');
});
