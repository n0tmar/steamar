'use strict';

// The mirror: the last verified answer to each call, kept in out/api/<name>.json so a render can read
// it without waiting and a machine without a network still opens. Keyed to the pinned server key.
// It is not a source of truth: only a reply the service signed is ever written here.
// Trap: a mirror hit is not contact. Only transport.js marks the service as answering.

const fs = require('node:fs');
const path = require('node:path');
const paths = require('./paths');
const { pinned_key, sha256_hex } = require('./device');

const CACHE_DIR = () => path.join(paths.out_dir(), 'api');

/* ---------- cache ---------- */

// The names are ours ("latest", "pkg-620", a hash); a name with a slash or dots in it is a path.
const CACHE_NAME = /^[\w-]+$/;

function cache_read(name) {
  if (!CACHE_NAME.test(name)) return null;
  try {
    const hit = JSON.parse(fs.readFileSync(path.join(CACHE_DIR(), `${name}.json`), 'utf8'));
    if (!hit || typeof hit !== 'object') return null;
    // A mirror is only good for the key that signed it: rotate the pin and every old answer is
    // stale by definition, even if the clock says otherwise.
    //
    // The tag is a hash of the pin, not its first characters: every Ed25519 SPKI key in base64 opens
    // with the same "MCowBQYDK2VwAyEA", so the first 16 characters of two different keys are the
    // same 16 characters. That tag would have matched every key that ever existed.
    if (hit.key !== cache_tag()) return null;
    return hit;
  } catch {
    return null;
  }
}

const cache_tag = () => sha256_hex(pinned_key()).slice(0, 16);

function cache_write(name, body) {
  if (!CACHE_NAME.test(name)) return;
  const dir = paths.ensure_dir(CACHE_DIR());
  const file = path.join(dir, `${name}.json`);
  try {
    fs.writeFileSync(`${file}.tmp`, JSON.stringify({ at: Date.now(), key: cache_tag(), body }), 'utf8');
    fs.renameSync(`${file}.tmp`, file);
  } catch { /* a read-only out/ still answers from memory */ }
}

// What a caller that cannot wait (a sync render, a status line) gets to see: the last good counts.
function counters() {
  const hit = cache_read('reach');
  const body = hit?.body || null;
  return {
    addable: Number(body?.addable) || 0,
    titles: Number(body?.supplier_titles) || 0,
    depot_keys: Number(body?.depot_keys) || 0,
    tokens: Number(body?.tokens) || 0,
    denuvo_titles: Number(body?.denuvo_titles) || 0,
    fixes: Number(body?.fixes) || 0,
    // Titles other machines have reported as failing. One number: the list itself belongs to the
    // service, and the search asks for a verdict when it needs one.
    failing: Number(body?.reports?.failing?.length) || 0,
    fetched: hit?.at || null,
  };
}

// The titles the service says are failing, worst first, from the last reach answer it signed. One
// list, no extra call: the cards and the settings page both read it from here.
function failing_titles(limit = 5) {
  const body = cache_read('reach')?.body || null;
  const list = body?.reports?.failing || [];
  return list.slice(0, limit).map((row) => ({
    appid: String(row.appid),
    total: Number(row.total) || 0,
    fails: Number(row.fails) || 0,
    rate: Number(row.rate) || 0,
    last_outcome: row.last_outcome || null,
    last_at: row.last_at || null,
  }));
}

module.exports = { CACHE_DIR, cache_read, cache_write, counters, failing_titles };
