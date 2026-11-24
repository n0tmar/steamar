'use strict';

// This machine as the service knows it: the ed25519 key in out/device.key, the identity in
// out/device.json, the pinned server key, and the signing rules both sides share (canonical,
// request_payload). It also opens a signed reply. It makes no network call: transport.js does.
// Trap: canonical, sha256_hex, request_payload and query_string are the wire contract. The service
// has its own copy in server/src/sign.js, and prove/wire.js a third; change all three or none.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const paths = require('./paths');

const IDENTITY_FILE = () => path.join(paths.out_dir(), 'device.json');
const KEY_FILE = () => path.join(paths.out_dir(), 'device.key');
const INSTALL_FILE = () => path.join(paths.out_dir(), 'install.id');

const fail = (code, message, extra = {}) => Object.assign(new Error(message), { api: true, code, ...extra });

/* ---------- config ---------- */

// config/steam.json is where a shipped build points, and the two environment variables are the
// escape hatch for a developer running a server on the same machine. The fallback below is the
// public origin the product lives on, so a build with no config at all still reaches a signed server
// instead of failing at the first call.
const defaults = () => ({
  base: process.env.STEAMAR_API || String(paths.config().api?.base || 'https://steamar.cc'),
  key: process.env.STEAMAR_API_KEY || String(paths.config().api?.public_key || ''),
  timeout_ms: Number(paths.config().api?.timeout_ms) || 12000,
});

function base_url() {
  return String(defaults().base || '').replace(/\/+$/, '');
}

const pinned_key = () => defaults().key.trim();
const timeout_ms = () => defaults().timeout_ms;

// Where the site lives, which is not always where the API lives: a developer can run the page and the
// service on two ports. Where they are one origin, this returns that origin.
function site_url() {
  return String(process.env.STEAMAR_SITE || paths.config().api?.site || base_url()).replace(/\/+$/, '');
}

/* ---------- the three functions the server also has ---------- */

// Sorted keys, no whitespace: two processes that agree on this agree on bytes.
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const parts = Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`);
  return `{${parts.join(',')}}`;
}

const sha256_hex = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

// What this device signs on every call. Path and query are inside it, so a signed request for one
// app id cannot be turned into a request for another.
function request_payload({ method, path: route, query, ts, nonce, body }) {
  return ['v1', String(method).toUpperCase(), route, query || '', String(ts), nonce, sha256_hex(body || '')].join('\n');
}

const query_string = (query) => Object.entries(query || {})
  .filter(([, value]) => value !== undefined && value !== null && value !== '')
  .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
  .join('&');

/* ---------- the machine's own key and name ---------- */

let key_cache = null;

function private_key() {
  if (key_cache) return key_cache;
  const file = KEY_FILE();
  if (paths.exists(file)) {
    try {
      key_cache = crypto.createPrivateKey(fs.readFileSync(file, 'utf8'));
      return key_cache;
    } catch (err) {
      // A damaged key file is a device the server has never heard of. Move it aside and start again
      // rather than crash the engine on every boot.
      fs.renameSync(file, `${file}.broken-${Date.now()}`);
      console.error(`api: ${path.basename(file)} was unreadable (${err.message}); made a new one`);
    }
  }
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  paths.ensure_dir(path.dirname(file));
  fs.writeFileSync(file, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  key_cache = privateKey;
  return key_cache;
}

const public_b64 = () => crypto.createPublicKey(private_key()).export({ type: 'spki', format: 'der' }).toString('base64');

// One id per install, so re-enrolling after a deleted identity still counts as the same machine and
// the server's four-devices-per-install ceiling means something.
function install_id() {
  const file = INSTALL_FILE();
  if (paths.exists(file)) {
    const value = fs.readFileSync(file, 'utf8').trim();
    if (/^[a-f0-9]{16,64}$/i.test(value)) return value;
  }
  const value = crypto.randomBytes(16).toString('hex');
  paths.ensure_dir(path.dirname(file));
  fs.writeFileSync(file, value, 'utf8');
  return value;
}

let identity_cache;

function identity() {
  if (identity_cache !== undefined) return identity_cache;
  try {
    const body = JSON.parse(fs.readFileSync(IDENTITY_FILE(), 'utf8'));
    identity_cache = body && body.device_id && body.token ? body : null;
  } catch {
    identity_cache = null;
  }
  return identity_cache;
}

function save_identity(value) {
  const file = IDENTITY_FILE();
  paths.ensure_dir(path.dirname(file));
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
  identity_cache = value;
  return value;
}

function forget() {
  identity_cache = null;
  try { fs.rmSync(IDENTITY_FILE(), { force: true }); } catch { /* nothing to forget */ }
}

/* ---------- replies ---------- */

let verify_key = null;
let verify_for = null; // the pin the cached key was built from

function server_public_key() {
  const b64 = pinned_key();
  if (!b64) {
    throw fail('not_configured', 'no server key is pinned in config/steam.json -> api.public_key, so no reply can be trusted');
  }
  // Keyed to the pin: a changed pin must build a new key. Caching one forever meant a rotated pin
  // still verified against the old half - the one thing the pin exists to prevent.
  if (!verify_key || verify_for !== b64) {
    let der;
    try { der = Buffer.from(b64, 'base64'); } catch { der = null; }
    if (!der || der.length !== 44 || der[0] !== 0x30) {
      throw fail('not_configured', 'the pinned api.public_key in config/steam.json is not a base64 SPKI Ed25519 key');
    }
    verify_key = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
    verify_for = b64;
  }
  return verify_key;
}

// reset() in api.js drops the built key along with the mirrors, so the next reply builds it again.
function forget_server_key() {
  verify_key = null;
}

// How far a reply's own clock may be from this one. The service refuses a request whose clock is more
// than two minutes off, so a device that can talk to it at all is inside this window by a wide margin,
// and a genuine reply is old only by the time it spent on the wire.
const REPLY_MAX_AGE_MS = 10 * 60 * 1000;

// A reply is only a reply if the pinned key signed it, for this device, and recently.
function open(reply, device_id) {
  if (!reply || typeof reply !== 'object' || !reply.sig) throw fail('unsigned_reply', 'the reply carried no signature');
  if (device_id && reply.device !== device_id) throw fail('wrong_device', 'the reply names a different device');
  const { sig, ...core } = reply;
  const ok = crypto.verify(
    null,
    Buffer.from(sha256_hex(canonical(core))),
    server_public_key(),
    Buffer.from(String(sig), 'base64'),
  );
  if (!ok) throw fail('bad_reply_signature', 'the reply does not answer for the pinned server key');
  // `ts` is inside the signature so that an old answer cannot be served again, which only works if
  // somebody reads it. Without this, a copy of last month's /v1/me (before a pause) or /v1/latest
  // (before a fix) passed for today's, from anything between this app and the service.
  if (!Number.isFinite(core.ts) || Math.abs(Date.now() - core.ts) > REPLY_MAX_AGE_MS) {
    throw fail('stale_reply', "the reply was signed too long ago to be an answer to this call (if this keeps happening, check that this PC's clock is right)");
  }
  return core.body;
}

module.exports = {
  fail, base_url, pinned_key, timeout_ms, site_url, canonical, sha256_hex, request_payload, query_string,
  private_key, public_b64, install_id, INSTALL_FILE, identity, save_identity, forget, open, forget_server_key,
};
