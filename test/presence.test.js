'use strict';

// The activity the app sets on Discord: one handshake, then one SET_ACTIVITY frame, then a frame
// taking it away. A pipe of our own stands in for Discord's, so nothing here needs Discord.
const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');

const presence = require('../src/presence');

// A frame is the opcode and the payload length in eight bytes, then the JSON.
function frames(chunks) {
  const all = Buffer.concat(chunks);
  const out = [];
  for (let at = 0; at + 8 <= all.length;) {
    const size = all.readUInt32LE(at + 4);
    out.push({ op: all.readUInt32LE(at), body: JSON.parse(all.subarray(at + 8, at + 8 + size).toString('utf8')) });
    at += 8 + size;
  }
  return out;
}

test('the app tells Discord it is running, and takes that back when it stops', { skip: process.platform !== 'win32' }, async () => {
  const pipe = `\\\\.\\pipe\\stm-presence-${process.pid}-${Date.now()}`;
  const chunks = [];
  const server = net.createServer((one) => one.on('data', (chunk) => chunks.push(chunk)));
  await new Promise((resolve) => server.listen(pipe, resolve));

  const settings = path.join(__dirname, '..', 'config', 'steam.json');
  const saved = fs.readFileSync(settings, 'utf8');
  const config = JSON.parse(saved);
  fs.writeFileSync(settings, JSON.stringify({ ...config, presence: { ...config.presence, app_id: '918273645' } }));

  try {
    await presence.start({ pipe });
    for (let i = 0; i < 40 && frames(chunks).length < 2; i += 1) await new Promise((r) => setTimeout(r, 50));
    const got = frames(chunks);
    assert.deepEqual(got[0], { op: 0, body: { v: 1, client_id: '918273645' } }, 'a handshake names the application');
    assert.equal(got[1].op, 1);
    assert.equal(got[1].body.cmd, 'SET_ACTIVITY');
    assert.deepEqual(got[1].body.args.activity, presence.activity(got[1].body.args.activity.timestamps.start), 'the activity is what the app draws');
    assert.match(got[1].body.args.activity.buttons[0].url, /^https:\/\//, 'the button goes to the site over https');
    assert.deepEqual(got[1].body.args.activity.buttons.map((one) => one.label), ['Get SteaMar', 'Discord'], 'and the invite sits beside it');

    presence.stop();
    for (let i = 0; i < 40 && frames(chunks).length < 3; i += 1) await new Promise((r) => setTimeout(r, 50));
    assert.equal(frames(chunks)[2].body.args.activity, null, 'stopping takes the activity away');
  } finally {
    presence.stop();
    fs.writeFileSync(settings, saved);
    await new Promise((resolve) => server.close(resolve));
  }
});
