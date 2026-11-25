'use strict';

// Discord's rich presence: while the window is open, the person's own Discord says "Playing SteaMar",
// with the mark, the line and a link to the site. It is Discord's own local pipe, so nothing leaves
// the PC and nothing is asked of the service. With no Discord running, or no application id in
// config/steam.json, every call here does nothing at all.
//
// The pipe is Discord's desktop client's, not a bot's: the app id in the config is the Discord
// application the marks are uploaded to (Rich Presence -> Art Assets, named logo and discord), and it
// is public, the same id every invite link carries. A handshake is one frame, the activity another.

const net = require('node:net');
const paths = require('./paths');

const OP = { handshake: 0, frame: 1, ping: 3, pong: 4 };
const RETRY_MS = 30_000;

// Discord listens on the first free pipe of ten; a second Discord client takes the next one.
const pipes = () => Array.from({ length: 10 }, (_, i) => `\\\\.\\pipe\\discord-ipc-${i}`);

let socket = null;
let retry = null;
let opened_at = Date.now();
let stopped = false;

// One frame: the opcode and the payload length, both little-endian, then the JSON in UTF-8.
function frame(op, data) {
  const body = Buffer.from(JSON.stringify(data), 'utf8');
  const head = Buffer.alloc(8);
  head.writeUInt32LE(op, 0);
  head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
}

function app_id() {
  return String((paths.config().presence || {}).app_id || '').trim();
}

// What Discord draws. The marks named here are uploaded to the Discord application; a name it does
// not know leaves the picture empty and the words in place, which is why none of this can break.
function activity(since = opened_at) {
  const settings = paths.config().presence || {};
  const site = String(paths.config().api?.site || 'https://steamar.cc').replace(/\/+$/, '');
  const buttons = [{ label: 'Website', url: site }];
  // Discord allows two buttons and no more; a second one that is not https is left out rather than
  // sent, because Discord drops the whole activity over one bad address.
  const invite = String(settings.discord || '').trim();
  if (/^https:\/\//.test(invite)) buttons.push({ label: 'Discord server', url: invite });
  return {
    details: 'Your Steam library, in one window',
    assets: { large_image: 'logo', large_text: 'SteaMar' },
    timestamps: { start: since },
    buttons,
  };
}

function send(op, data) {
  if (socket && !socket.destroyed) socket.write(frame(op, data));
}

function set() {
  send(OP.frame, { cmd: 'SET_ACTIVITY', args: { pid: process.pid, activity: activity() }, nonce: String(Date.now()) });
}

function clear() {
  send(OP.frame, { cmd: 'SET_ACTIVITY', args: { pid: process.pid, activity: null }, nonce: String(Date.now()) });
}

function later() {
  if (stopped || retry) return;
  retry = setTimeout(() => {
    retry = null;
    start();
  }, RETRY_MS);
  if (retry.unref) retry.unref();
}

function try_pipe(name) {
  return new Promise((resolve) => {
    const one = net.connect(name);
    one.once('connect', () => resolve(one));
    one.once('error', () => {
      one.destroy();
      resolve(null);
    });
  });
}

async function start({ pipe = null } = {}) {
  stopped = false;
  if (socket) return;
  const id = app_id();
  // Windows is where the desktop client keeps its pipes; anywhere else this stays out of the way.
  if (!id || process.platform !== 'win32') return;
  const found = pipe ? await try_pipe(pipe) : await first_pipe();
  if (!found || stopped) {
    if (found) found.destroy();
    return later();
  }
  socket = found;
  opened_at = Date.now();
  socket.on('data', (chunk) => {
    // A ping is the only frame worth an answer; the rest is Discord's reply to what was sent.
    for (let at = 0; at + 8 <= chunk.length;) {
      const op = chunk.readUInt32LE(at);
      const size = chunk.readUInt32LE(at + 4);
      if (op === OP.ping) send(OP.pong, {});
      at += 8 + size;
    }
  });
  socket.on('close', () => {
    socket = null;
    later();
  });
  socket.on('error', () => socket && socket.destroy());
  send(OP.handshake, { v: 1, client_id: id });
  set();
}

async function first_pipe() {
  for (const name of pipes()) {
    const one = await try_pipe(name);
    if (one) return one;
  }
  return null;
}

function stop() {
  stopped = true;
  if (retry) clearTimeout(retry);
  retry = null;
  clear();
  if (socket) socket.end();
  socket = null;
}

module.exports = { start, stop, activity, frame, pipes };
