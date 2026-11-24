'use strict';

// The engine has no password; who may reach it is decided here. Each case is an attack or a caller
// that must keep working.

const test = require('node:test');
const assert = require('node:assert/strict');
const { origin_allowed } = require('../src/origin');

const ask = (method, headers) => origin_allowed({ method, headers });

test('a rebound hostname is refused, for reads and for writes', () => {
  const rebound = { host: 'evil.example:8788', origin: 'http://evil.example:8788' };
  assert.equal(ask('POST', rebound), false);
  assert.equal(ask('GET', { host: 'evil.example:8788' }), false);
  assert.equal(ask('GET', { host: '127.0.0.1.evil.example:8788' }), false);
});

test('loopback names are served, with or without a port', () => {
  for (const host of ['127.0.0.1:8788', 'localhost:8788', '[::1]:8788', 'LOCALHOST']) {
    assert.equal(ask('GET', { host }), true, host);
  }
});

test('writes: no origin, our page and the same host pass; foreign and opaque origins do not', () => {
  const host = '127.0.0.1:8788';
  assert.equal(ask('POST', { host }), true, 'native shell sends no origin');
  assert.equal(ask('POST', { host, origin: 'https://steamar.cc' }), true);
  assert.equal(ask('POST', { host, origin: 'http://127.0.0.1:8788' }), true);
  assert.equal(ask('POST', { host, origin: 'https://evil.example' }), false);
  assert.equal(ask('POST', { host, origin: 'null' }), false);
  assert.equal(ask('POST', { host, origin: 'not a url' }), false);
});
