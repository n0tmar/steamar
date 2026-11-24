'use strict';

// One signed call to the service: sign the request, send it through net.js, open the signed reply,
// retry once for a stale clock or a dead identity, and enroll this device when it has none.
// It also remembers when the service last answered and the last failure, for the settings page.
// Trap: post_json with { signed: false } is only for enrollment; every other call must be signed.

const crypto = require('node:crypto');
const { version: APP_VERSION } = require('../package.json');
const net = require('./net');
const {
  fail, base_url, pinned_key, timeout_ms, request_payload, query_string, private_key, public_b64,
  install_id, identity, save_identity, forget, open,
} = require('./device');
const { cache_read, cache_write } = require('./mirror');

/* ---------- talking to the server ---------- */

async function post_json(route, payload, { signed = true, query = {} } = {}) {
  const text = payload === undefined ? '' : JSON.stringify(payload);
  const qs = query_string(query);
  const url = `${base_url()}${route}${qs ? `?${qs}` : ''}`;
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json',
    'user-agent': `SteaMar/${APP_VERSION} (+win32)`,
    // The build, on every call. The version a device runs is recorded at enrollment, and a build
    // updated in place keeps its device.json and never enrolls again - so the row can be older than
    // the binary. This is a hint, not a credential: it decides only which answer the caller gets
    // about its own build, and none of it is signed.
    'x-stm-app': APP_VERSION,
  };

  let me = null;
  if (signed) {
    me = await ensure_identity();
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const signature = crypto.sign(null, Buffer.from(request_payload({ method: 'POST', path: route, query: qs, ts, nonce, body: text })), private_key());
    headers.authorization = `SteaMar ${me.device_id}.${me.token}`;
    headers['x-stm-ts'] = String(ts);
    headers['x-stm-nonce'] = nonce;
    headers['x-stm-sig'] = signature.toString('base64');
  }

  let res;
  try {
    res = await net.fetch(url, { method: 'POST', headers, body: text || undefined, signal: AbortSignal.timeout(timeout_ms()) });
  } catch (err) {
    const why = err.name === 'TimeoutError' ? 'the service did not answer in time' : 'the service could not be reached';
    throw fail('unreachable', `${why} (${base_url()})`, { cause: err.message });
  }

  const raw = await res.text();
  let body = null;
  try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }

  if (!res.ok) {
    const code = body?.error?.code || `http_${res.status}`;
    const message = body?.error?.message || `the service answered ${res.status}`;
    const retry_after = Number(res.headers.get('retry-after')) || null;
    const err = fail(code, message, { status: res.status, retry_after, detail: body?.error || null });
    // The two ways an identity dies. Both are recoverable: enroll again, once.
    if (code === 'unknown_device' || code === 'bad_token') err.re_enroll = true;
    if (code === 'stale') err.retry = true;
    throw err;
  }

  const envelope = body && typeof body === 'object' && 'sig' in body ? body : null;
  if (!signed) {
    // Health and enrollment are answered unsigned; the payload is one level down.
    mark_ok();
    return body?.body && typeof body.body === 'object' ? body.body : body;
  }
  try {
    const value = open(envelope || { body }, me?.device_id);
    mark_ok();
    return value;
  } catch (err) {
    if (err.code && err.api) throw err;
    throw fail('bad_reply', `the reply could not be read (${err.message})`);
  }
}

async function get(route, { query = {}, ttl = 0, cache_name = null } = {}) {
  const text = '';
  const qs = query_string(query);
  const cacheable = cache_name && ttl > 0;
  if (cacheable) {
    const hit = cache_read(cache_name);
    if (hit && Date.now() - hit.at < ttl) return hit.body;
  }

  const me = await ensure_identity();
  const url = `${base_url()}${route}${qs ? `?${qs}` : ''}`;
  const ts = Date.now();
  const nonce = crypto.randomBytes(16).toString('hex');
  const signature = crypto.sign(null, Buffer.from(request_payload({ method: 'GET', path: route, query: qs, ts, nonce, body: text })), private_key());

  let res;
  try {
    res = await net.fetch(url, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        'user-agent': `SteaMar/${APP_VERSION} (+win32)`,
        // The build this binary is, said on the call rather than remembered by the server: see the
        // note in post_json. A server with a floor reads this first and the device row second.
        'x-stm-app': APP_VERSION,
        authorization: `SteaMar ${me.device_id}.${me.token}`,
        'x-stm-ts': String(ts),
        'x-stm-nonce': nonce,
        'x-stm-sig': signature.toString('base64'),
      },
      signal: AbortSignal.timeout(timeout_ms()),
    });
  } catch (err) {
    const why = err.name === 'TimeoutError' ? 'the service did not answer in time' : 'the service could not be reached';
    throw fail('unreachable', `${why} (${base_url()})`, { cause: err.message });
  }

  const raw = await res.text();
  let body = null;
  try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }

  if (!res.ok) {
    const code = body?.error?.code || `http_${res.status}`;
    const err = fail(code, body?.error?.message || `the service answered ${res.status}`, {
      status: res.status,
      retry_after: Number(res.headers.get('retry-after')) || null,
      detail: body?.error || null,
    });
    if (code === 'unknown_device' || code === 'bad_token') err.re_enroll = true;
    if (code === 'stale') err.retry = true;
    throw err;
  }

  let value;
  try {
    value = open(body, me.device_id);
  } catch (err) {
    if (err.code && err.api) throw err;
    throw fail('bad_reply', `the reply could not be read (${err.message})`);
  }
  mark_ok();
  if (cacheable) cache_write(cache_name, value);
  return value;
}

// One retry, one rule: a dead identity is replaced, a stale clock is re-signed. Nothing else retries.
// What the service last did is recorded where the reply is verified (mark_ok) or the call fails
// (mark_error), not here: this function cannot tell a real answer from a mirror read.
async function call(runner) {
  // attempt 0, then at most one of: re-sign (stale clock) or re-enroll (dead identity).
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await runner();
    } catch (err) {
      mark_error(err);
      if (attempt === 0 && err.retry) {
        err.retry = false;
        continue;
      }
      if (attempt === 0 && err.re_enroll) {
        forget();
        await enroll();
        continue;
      }
      throw err;
    }
  }
}

/* ---------- identity ---------- */

let enrolling = null;

async function enroll() {
  if (enrolling) return enrolling;
  if (!pinned_key()) throw fail('not_configured', 'config/steam.json has no api.public_key, so there is nothing to trust');

  enrolling = (async () => {
    const reply = await post_json('/v1/enroll', {
      pubkey: public_b64(),
      install_id: install_id(),
      app_version: APP_VERSION,
      platform: 'win32',
    }, { signed: false });

    // An enrollment answered by anyone but the pinned server is a hostile answer. Check before the
    // token is saved, so a mirror gets nothing.
    if (reply?.server_key !== pinned_key()) {
      throw fail('key_mismatch', 'the server that answered enrollment does not hold the pinned key');
    }
    if (!reply?.device_id || !reply?.token) throw fail('bad_enroll', 'enrollment came back without a device id');

    return save_identity({
      device_id: reply.device_id,
      token: reply.token,
      install_id: install_id(),
      base: base_url(),
      app_version: APP_VERSION,
      enrolled_at: Date.now(),
    });
  })();

  try {
    return await enrolling;
  } finally {
    enrolling = null;
  }
}

async function ensure_identity() {
  const me = identity();
  if (me && me.base === base_url()) return me;
  if (me && me.base !== base_url()) forget(); // a different server means a different identity
  return enroll();
}

let last_ok = null;
let last_error = null;

// Only a verified reply moves these. A mirror read is not an answer from the service: it is
// yesterday's answer handed back, and counting it as contact is how the app came to report a live
// service it had not reached since boot.
function mark_ok() {
  last_ok = Date.now();
  last_error = null;
}

function mark_error(err) {
  // A 404 for an app the service does not cover is an answer, not an outage.
  if (err.code === 'unknown_app' || err.code === 'no_fix') return;
  last_error = { at: Date.now(), code: err.code || 'error', message: err.message };
}

// What the service last did, for the settings page and the account screen. warm() in api.js records
// a failed boot with note_error, and reset() forgets both.
const seen = () => ({ last_ok, last_error });
const note_error = (value) => { last_error = value; };
const forget_contact = () => { last_ok = null; last_error = null; };

module.exports = { post_json, get, call, seen, note_error, forget_contact };
