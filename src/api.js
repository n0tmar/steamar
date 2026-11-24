'use strict';

// The facade the rest of the engine calls for anything from the service: data, updates, state, boot.
// It does not sign or send itself; device.js, transport.js, mirror.js and account.js do.
// Trap: it is not website/src/lib/api.js, which is the site's browser fetch helper.

// The only door out of this app.
//
// Everything the supplier gave us lives on the server now: depot keys, access tokens, the title
// index, the Denuvo list, the fix catalogue. None of it ships in this folder, and none of it can be
// fetched without a device that signs its own requests. This module is the one place that knows how.
//
//   one keypair    out/device.key     ed25519, made on first run, never leaves the machine
//   one identity   out/device.json    { device_id, token, install_id }
//   one server     config/steam.json  -> api { base, public_key }
//
// A call carries `Authorization: SteaMar <device>.<token>` and a signature over
// `v1, METHOD, path, query, ts, nonce, sha256(body)`. The reply comes back signed by a key pinned in
// config, so a proxy, a mirror or a hosts file cannot answer in the server's place.
//
// The private key is what makes the token worth having: a copy of out/device.json opens nothing on
// its own, and a copy of this file opens nothing at all.
//
// The door is five files. This one is what the rest of the app calls: the update channel, the data
// calls, the state the pages read, boot and reset. device.js is the key and the signing rules,
// transport.js one signed call, mirror.js the last good answers on disk, account.js who is here.
// Nothing outside the five requires the other four.

const fs = require('node:fs');
const path = require('node:path');
const paths = require('./paths');
const { version: APP_VERSION } = require('../package.json');
const { base_url, site_url, pinned_key, identity, install_id, INSTALL_FILE, sha256_hex, forget_server_key } = require('./device');
const { CACHE_DIR, cache_read, cache_write, counters, failing_titles } = require('./mirror');
const { call, get, post_json, seen, note_error, forget_contact } = require('./transport');
const { me, refresh_account, link_start, link_status, sign_out, campaign, account_view, seen_me } = require('./account');

// Fresh enough to be useful, old enough that a session is not a stream of requests. The server
// budgets 120 calls a minute per device; these are the numbers that keep a normal day far below it.
const TTL = {
  package: 10 * 60 * 1000,
  search: 2 * 60 * 1000,
  reach: 10 * 60 * 1000,
  denuvo: 60 * 60 * 1000,
  // The Fixes tab asks again each time it opens, so a release added on the service shows within the hour.
  fixes: 60 * 60 * 1000,
  fix_link: 6 * 60 * 60 * 1000,
  // The update channel is checked at boot and then forgotten for half a day: a build that is a week
  // old still learns about a release, and a machine that opens twice an hour costs two calls a day.
  latest: 12 * 60 * 60 * 1000,
  verdicts: 10 * 60 * 1000,
};

/* ---------- the calls the app makes ---------- */

// The update channel: a signed manifest compared against the build running here. `update` is one of
// none / optional / required / unknown, and the sha256 is what an installer is checked against
// before it runs - the one thing a signed channel buys over a link in a Discord post. A reply that
// does not verify never reaches this line: get() throws first.
async function latest(force = false) {
  // The mirror is keyed on the build that asked, not only on the pinned key: a verdict computed for
  // 0.4.0 is not an answer for 0.5.0, and a cache written before a release existed must not hide it
  // for twelve hours. An "unknown" answer is kept for half an hour, then asked again - that is the
  // window between an operator publishing a build and the app noticing.
  //
  // `force` is the person pressing check: a cached answer is the one thing they did not ask for.
  const hit = cache_read('latest');
  const mine = hit && hit.body && hit.body.now === APP_VERSION;
  const window_ms = hit && hit.body && hit.body.update === 'unknown' ? 30 * 60 * 1000 : TTL.latest;
  if (!force && mine && Date.now() - hit.at < window_ms) {
    last_latest = hit.body;
    last_latest_at = hit.at;
    return hit.body;
  }

  try {
    const answer = await call(() => get('/v1/latest', { query: { version: APP_VERSION } }));
    last_latest = answer;
    last_latest_at = Date.now();
    // Written even when the answer is "unknown": the short window above is what keeps a service
    // without a manifest from being asked on every boot.
    if (answer) cache_write('latest', answer);
    return answer;
  } catch (err) {
    // A service published before this route existed answers 404. That is not an outage, and it must
    // not be recorded as one: the app simply has nothing to compare itself against.
    if (err.code === 'not_found') {
      last_latest = null;
      last_latest_at = Date.now();
      return { now: APP_VERSION, latest: null, update: 'unknown', note: 'the service has no update channel' };
    }
    throw err;
  }
}

// Pre-flight for a page of cards in one call. Ids the service does not know stay out of the answer
// rather than being guessed at: a card with no verdict is offered as it was before, and the add
// itself says what happened.
const verdicts = (ids = []) => {
  const list = [...new Set(ids.map((id) => String(id)).filter((id) => /^\d{1,10}$/.test(id)))].slice(0, 60);
  if (!list.length) return Promise.resolve({ verdicts: {} });
  return call(() => get('/v1/verdicts', {
    query: { appids: list.join(',') },
    cache_name: `verdicts-${sha256_hex(list.join(',')).slice(0, 16)}`,
    ttl: TTL.verdicts,
  }));
};

// What happened when a person pressed add, sent so the service learns from installs it cannot see.
// This promise never rejects: telemetry must not be the reason an add looks broken.
function report(payload = {}) {
  return call(() => post_json('/v1/report', {
    appid: String(payload.appid || ''),
    outcome: String(payload.outcome || 'unknown'),
    version: APP_VERSION,
    steam_build: payload.steam_build || null,
    detail: payload.detail || null,
    log_tail: Array.isArray(payload.log_tail) ? payload.log_tail.slice(-40) : [],
  })).catch(() => null);
}

// The shelf this PC has built, sent whole to the service so the website can show it. The app reads the
// Steam folder anyway (library.scripts); this is the same list, on the other side of the wire.
//
// It is sent when it has changed, not on a timer: the hash of the ids is the whole test, so a rescan
// that finds the same twelve games costs one promise and no request. Nothing here identifies a person
// beyond the device the service already knows, and a sync that fails is a stale page, never a failed
// add - so it never rejects.
let synced_tag = null;
let attempted_at = 0;

function library_sync(games = []) {
  const list = (Array.isArray(games) ? games : [])
    .map((game) => ({
      appid: String((game && game.appid) || ''),
      at: game && Number(game.mtime) ? new Date(Number(game.mtime)).toISOString() : undefined,
    }))
    .filter((game) => /^\d{1,10}$/.test(game.appid))
    .slice(0, 600);

  const tag = sha256_hex(list.map((game) => game.appid).sort().join(',')).slice(0, 16);
  if (tag === synced_tag) return Promise.resolve({ count: list.length, unchanged: true });

  // A device that is not attached to a person yet is refused (409 not_linked), and this function is
  // called on every library refresh - so a failed attempt buys a minute of silence instead of a
  // request per repaint. It heals by itself: the next attempt after a link goes through.
  const now = Date.now();
  if (now - attempted_at < 60000) return Promise.resolve({ count: list.length, throttled: true });
  attempted_at = now;

  return call(() => post_json('/v1/library', { games: list }))
    .then((answer) => {
      synced_tag = tag;
      return answer;
    })
    .catch(() => null);
}

const reach = () => call(() => get('/v1/reach', { cache_name: 'reach', ttl: TTL.reach }));
const denuvo = () => call(() => get('/v1/denuvo', { cache_name: 'denuvo', ttl: TTL.denuvo }));
const fixes = () => call(() => get('/v1/fixes', { cache_name: 'fixes', ttl: TTL.fixes }));

const package_for = (appid) => call(() => get('/v1/package', {
  query: { appid: String(appid) },
  cache_name: `pkg-${appid}`,
  ttl: TTL.package,
}));

const search = (term, limit = 12) => call(() => get('/v1/search', {
  query: { q: String(term).slice(0, 80), limit },
  cache_name: `search-${sha256_hex(String(term).toLowerCase()).slice(0, 16)}-${limit}`,
  ttl: TTL.search,
}));



// One release's file. The service resolves it and remembers the answer for every device; this side
// remembers it too, for six hours, so a second click in the same session is a disk read. The client
// holds no resolver: which host answers, and how a mirror is turned into a file, is not here.
const fix_link = (id) => call(() => get('/v1/fix/link', {
  query: { id: String(id) },
  cache_name: `fix-link-${sha256_hex(String(id)).slice(0, 16)}`,
  ttl: TTL.fix_link,
}));

let last_latest = null;
let last_latest_at = null;

function state() {
  const { last_ok, last_error } = seen();
  const { last_campaign } = seen_me();
  const pinned = pinned_key();
  const id = identity();
  const counts = counters();
  return {
    configured: Boolean(pinned),
    base: base_url(),
    key: pinned ? `${pinned.slice(0, 12)}…` : null,
    enrolled: Boolean(id),
    device_id: id?.device_id || null,
    enrolled_at: id?.enrolled_at || null,
    install_id: paths.exists(INSTALL_FILE()) ? install_id() : null,
    last_ok: last_ok ? new Date(last_ok).toISOString() : null,
    last_error: last_error ? { at: new Date(last_error.at).toISOString(), code: last_error.code, message: last_error.message } : null,
    counts,
    update: update_view(),
    account: account_view(),
    campaign: last_campaign,
  };
}

// What the settings page needs to draw one line: is there a newer build, and where is it. Read from
// the cache first, so a render never waits on the network; last_latest is the answer this session
// actually verified, which wins when it exists.
function update_view() {
  const { last_me, last_me_at } = seen_me();
  const cached = cache_read('latest');
  // A mirror written for another build is not an answer about this one.
  const usable = cached && cached.body && cached.body.now === APP_VERSION ? cached.body : null;
  const answer = last_latest || usable || null;
  // When the service last said anything about updates. "This is the newest build" is only worth
  // printing beside the moment it was true.
  const checked_at = last_latest_at
    ? new Date(last_latest_at).toISOString()
    : usable && cached ? new Date(cached.at).toISOString() : null;

  // The floor the service is enforcing outranks the release manifest, and is the one answer that
  // arrives when there is no manifest at all. /v1/me is exempt from the floor precisely so it can
  // report it; without reading it here, a service with no published release would leave the row
  // saying "unknown" while every data route refused this build and the shelf stayed empty.
  const floor = last_me && last_me.update_required ? last_me : null;
  if (floor && !(answer && answer.update === 'required')) {
    return {
      state: 'required',
      version: floor.min_app_version || null,
      // No download of its own: the address and the checksum belong to the published release, and a
      // button that cannot verify what it fetches is worse than no button.
      url: null,
      sha256: null,
      checked_at: new Date(last_me_at || Date.now()).toISOString(),
      notes: 'nothing is answered until this build is replaced',
    };
  }

  if (!answer) return { state: 'unknown', version: null, url: null, sha256: null, checked_at };
  if (answer.update === 'none' || answer.update === 'unknown') {
    return { state: answer.update, version: null, url: null, sha256: null, checked_at, note: answer.note || null };
  }
  return {
    state: answer.update,
    version: answer.latest?.version || null,
    url: answer.latest?.url || null,
    sha256: answer.latest?.sha256 || null,
    notes: answer.latest?.notes || null,
    checked_at,
  };
}

// Boot work: the counters the shelf quotes, the Denuvo list, the fix index and the update check,
// all warmed in the background. Nothing here is allowed to fail the engine — a machine with no network still opens,
// and every panel says what is missing instead of guessing.
async function warm() {
  const jobs = [
    // Who is on this PC. The window draws the door or the app from this one answer, and a cold
    // start has not asked it yet: without this job every launch begins as a stranger.
    ['account', refresh_account],
    ['reach', reach],
    ['denuvo', denuvo],
    ['fixes', fixes],
    // The boot check that did not exist: a build that is a week old asks once and learns it.
    ['latest', latest],
  ];
  // The three run at once and land in any order, so they cannot each write the shared state as they
  // finish: a success arriving second used to erase a failure that arrived first, and the settings
  // page then reported a service it had just failed to reach. Collect first, decide once.
  //
  // Nothing here marks the service healthy. A cache hit is a mirror read, so only a real reply may
  // set last_ok - which is what the settings page means by "last answered".
  const outcomes = await Promise.all(jobs.map(async ([name, run]) => {
    try {
      await run();
      return { name, ok: true };
    } catch (err) {
      if (name === 'reach') console.error(`api: ${err.message}`);
      return { name, ok: false, err };
    }
  }));

  const failed = outcomes.filter((o) => !o.ok);
  if (failed.length) {
    const first = failed[0].err;
    note_error({
      at: Date.now(),
      code: first.code || 'error',
      message: first.message,
      failed: failed.map((o) => o.name),
    });
  }
  return state();
}

// Forget the identity and the mirrors: a renamed server, a rotated key, or a person starting over.
function reset() {
  for (const name of fs.existsSync(CACHE_DIR()) ? fs.readdirSync(CACHE_DIR()) : []) {
    if (name.endsWith('.json')) { try { fs.rmSync(path.join(CACHE_DIR(), name), { force: true }); } catch { /* in use */ } }
  }
  forget_server_key();
  forget_contact();
}

module.exports = {
  state, warm, reset, latest, verdicts, report, library_sync, reach, denuvo, fixes, fix_link, search,
  package_for, counters, failing_titles, me, refresh_account, account_view, link_start, link_status, sign_out,
  campaign, base_url, site_url,
};
