'use strict';

// The transport, tested against a real socket on loopback.
//
// The cases are the ones that decide whether ten thousand installs are cheap or expensive: is the
// connection reused, is the reply unwrapped, is a 503 during a deploy retried, and is a POST that may
// have already happened left alone.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const zlib = require('node:zlib');

const net = require('../src/net');

let server;
let port;
let connections = 0;
let hits = 0;
let fail_first = 0;

test.before(async () => {
  server = http.createServer((req, res) => {
    hits += 1;

    if (req.url === '/flaky' && hits <= fail_first) {
      res.writeHead(503, { 'content-type': 'application/json', 'retry-after': '0' });
      return res.end(JSON.stringify({ error: { code: 'paused', message: 'not right now' } }));
    }

    if (req.url === '/flaky-post') {
      res.writeHead(503, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { code: 'paused', message: 'not right now' } }));
    }

    const body = zlib.gzipSync(Buffer.from(JSON.stringify({ ok: true, url: req.url })));
    res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip', 'content-length': String(body.length) });
    res.end(body);
  });
  server.on('connection', () => {
    connections += 1;
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

test.after(() => {
  server.close();
  net.agents['http:'].destroy();
});

const base = () => `http://127.0.0.1:${port}`;

test('two calls to one host share one connection', async () => {
  connections = 0;
  const first = await net.fetch(`${base()}/one`);
  const second = await net.fetch(`${base()}/two`);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(connections, 1, 'the second call reused the socket the first opened');
});

test('a gzipped reply is unwrapped before anyone parses it', async () => {
  const reply = await net.fetch(`${base()}/wrapped`);
  // Asking for the raw bytes would give the compressed stream; json() has already seen plain text.
  const doc = await reply.json();
  assert.equal(doc.ok, true);
  assert.equal(doc.url, '/wrapped');
  assert.equal(reply.headers.get('content-encoding'), 'gzip', 'the header still tells the truth');
});

test('a 503 on a GET is retried, and the retry is what the caller sees', async () => {
  hits = 0;
  fail_first = 2;
  const reply = await net.fetch(`${base()}/flaky`);
  assert.equal(reply.status, 200);
  assert.equal(hits, 3, 'two refusals, then the answer');
});

test('a 503 on a POST is not retried, because it may already have happened', async () => {
  hits = 0;
  fail_first = 99;
  const reply = await net.fetch(`${base()}/flaky-post`, { method: 'POST', body: '{"a":1}' });
  assert.equal(reply.status, 503);
  assert.equal(hits, 1, 'one attempt, and the caller decides what to do about it');
});

test('a connection that was never opened is refused, and the caller hears about it', async () => {
  // Nothing is listening on this port, so no bytes were sent - which is why a POST is safe to retry.
  await assert.rejects(() => net.fetch('http://127.0.0.1:1/nothing', { method: 'POST', body: '{}' }));
});

test('the timeout a caller passes is the timeout it gets', async () => {
  const slow = http.createServer((req, res) => {
    setTimeout(() => {
      res.writeHead(200).end('{}');
    }, 500);
  });
  await new Promise((resolve) => slow.listen(0, '127.0.0.1', resolve));
  const slow_port = slow.address().port;
  try {
    await assert.rejects(() => net.fetch(`http://127.0.0.1:${slow_port}/slow`, { signal: AbortSignal.timeout(50) }));
  } finally {
    slow.close();
  }
});
