'use strict';

// Who is using this PC: the /v1/me answer (kept in memory and on disk), the link code that attaches
// this machine to a Discord account in the real browser, and the month's public campaign numbers.
// It never holds a Discord login; the browser does that on the site.
// Trap: account_view() must answer without a network call, so it reads memory, then the saved copy.

const { version: APP_VERSION } = require('../package.json');
const net = require('./net');
const { fail, base_url, timeout_ms, site_url } = require('./device');
const { cache_read, cache_write } = require('./mirror');
const { call, get, post_json, seen } = require('./transport');

// The app's identity call, and the only answer kept whole: the header, the sign-in screen, the paused
// screen, the account panel and the busy pill all draw from this one reply. `last_me` is what a
// synchronous render can see without waiting.
let last_me = null;
let last_me_at = null;

async function me() {
  const answer = await call(() => get('/v1/me'));
  last_me = answer || null;
  last_me_at = last_me ? Date.now() : null;
  if (last_me) {
    if (last_me.campaign) {
      last_campaign = last_me.campaign;
      last_campaign_at = last_me_at;
    }
    // The answer is also kept on disk, because "who uses this PC" is asked before the network is
    // known to work. Without it a machine that has been signed in for months starts as a stranger
    // the one time the service is down.
    cache_write('account', view_of(last_me, last_me_at));
  }
  return last_me;
}

// The identity question, asked at most once a minute, never twice at once, and not again for a
// quarter of a minute after it fails. Nothing in the window draws until it is answered, which is
// why it is a function of its own instead of a line inside boot.
const IDENTITY_TTL = 60000;
const IDENTITY_RETRY = 15000;
// A saved answer is the app's memory of who was here. One month: long enough to cover a holiday
// without a network, short enough that a copy nobody has opened since spring asks again.
const IDENTITY_SAVED_MAX = 30 * 24 * 60 * 60 * 1000;

let identity_call = null;
let identity_ok_at = 0;
let identity_fail_at = 0;

function refresh_account({ force = false } = {}) {
  if (identity_call) return identity_call;
  const now = Date.now();
  if (!force) {
    if (last_me && now - identity_ok_at < IDENTITY_TTL) return Promise.resolve(last_me);
    if (now - identity_fail_at < IDENTITY_RETRY) return Promise.resolve(last_me);
  }
  identity_call = me()
    .then((answer) => { identity_ok_at = Date.now(); return answer; })
    // A failure is already on last_error, where every panel that asks can read it. Nobody waits on
    // this promise for an error: the window asks "who is here", and "nobody that I can prove" is
    // an answer too.
    .catch(() => { identity_fail_at = Date.now(); return null; })
    .finally(() => { identity_call = null; });
  return identity_call;
}

const account_busy = () => Boolean(identity_call);

/* ---------- who is using this PC ---------- */

// Attaching this machine to a person, without ever putting a Discord login in this window: ask for a
// code, send the browser to the page that claims it, and poll until the claim lands.
const link_start = () => call(() => post_json('/v1/link/start'));

function link_status(code) {
  if (!code) throw fail('bad_code', 'a link code is required');
  return call(() => post_json('/v1/link/status', { code }));
}

// Sign this PC out: the service forgets the person, then the account is asked again so the window and
// the saved copy both say "not signed in" straight away.
async function sign_out() {
  await call(() => post_json('/v1/link/forget'));
  // A question already in flight was asked while signed in; its answer must not be the last word.
  if (identity_call) await identity_call.catch(() => null);
  return refresh_account({ force: true });
}

// The month, public and cheap: the same numbers the site shows. Cached for a minute, because a paused
// screen that flashes "loading" on every repaint is a worse apology than none.
let last_campaign = null;
let last_campaign_at = null;

async function campaign({ force = false } = {}) {
  if (!force && last_campaign && Date.now() - last_campaign_at < 60000) return last_campaign;
  const url = `${base_url()}/v1/campaign`;
  let res;
  try {
    res = await net.fetch(url, {
      headers: { accept: 'application/json', 'user-agent': `SteaMar/${APP_VERSION} (+win32)` },
      signal: AbortSignal.timeout(timeout_ms()),
    });
  } catch (err) {
    throw fail('unreachable', `the service could not be reached (${base_url()})`, { cause: err.message });
  }
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  if (!res.ok) {
    throw fail(body?.error?.code || `http_${res.status}`, body?.error?.message || `the service answered ${res.status}`, { status: res.status });
  }
  const payload = body?.body && typeof body.body === 'object' ? body.body : body;
  if (!payload) throw fail('bad_reply', 'the campaign reply was empty');
  last_campaign = payload;
  last_campaign_at = Date.now();
  return payload;
}

// The shape the window draws, from one identity reply: the person, the role, the pass, the month.
// The person's public page, with its link and pictures made whole: the window shows them as they are
// and never needs to know where the site is. The window checks what it puts into a class or an
// address, and a link is only ever opened by the engine (POST /api/profile).
function profile_of(profile) {
  if (!profile || !profile.path) return null;
  const site = site_url();
  const picture = (view) => (view && view.image_url ? { image_url: `${site}${view.image_url}` } : null);
  const bg = profile.background || {};
  return {
    url: `${site}${profile.path}`,
    handle: String(profile.path).replace(/^\/@/, ''),
    hidden: Boolean(profile.hidden),
    owner: Boolean(profile.owner),
    background: picture(bg) || { preset: bg.preset || 'night' },
    banner: picture(profile.banner),
    frame: profile.frame || null,
    bio: String(profile.bio || ''),
    links: (Array.isArray(profile.links) ? profile.links : []).map((link) => ({ kind: String((link && link.kind) || ''), url: String((link && link.url) || '') })),
    pronouns: profile.pronouns || null,
    status: profile.status || null,
  };
}

function view_of(me, at = last_me_at) {
  return {
    known: true,
    checked_at: at ? new Date(at).toISOString() : null,
    device_id: me.device_id || null,
    platform: me.platform || null,
    app_version: me.app_version || null,
    linked: Boolean(me.linked),
    user: me.user || null,
    tier: me.tier || 'none',
    pass: me.pass || null,
    paused: me.paused || null,
    // Not a month that went short, and not a person without a role: the operator turned the product
    // off. It is carried like the pause - one field the window reads - and drawn as its own screen
    // because the sentence it needs is different.
    kill: me.kill || null,
    peak: me.peak || null,
    campaign: me.campaign || last_campaign || null,
    gate: Boolean(me.gate),
    // The games the owner put at the top of Home, kept with the account so a start shows them at once.
    home: me.home || null,
    profile: profile_of(me.profile),
  };
}

// Everything the account screen needs, with no call of its own. Three sources, and the answer says
// which one it came from: `live` (asked just now), `saved` (the last time this PC was asked, on
// disk), `asking` (a question is in flight) or `none` (nobody has ever answered here).
function account_view() {
  const { last_error } = seen();
  if (last_me) return { ...view_of(last_me), source: 'live' };

  const saved = cache_read('account');
  if (saved && saved.body && saved.body.known && Date.now() - Number(saved.at || 0) < IDENTITY_SAVED_MAX) {
    return {
      ...saved.body,
      source: 'saved',
      // When it was true, not when it was read: the window says "last checked" with this.
      checked_at: new Date(saved.at).toISOString(),
      // A saved copy is shown at every start while today's answer is on its way. Only a copy with no
      // question in flight means the service is out of reach, and only that one is drawn as offline.
      asking: account_busy(),
    };
  }

  return {
    known: false, linked: false, tier: 'none', user: null, pass: null, paused: null,
    peak: null, campaign: last_campaign, gate: null, checked_at: null,
    source: account_busy() ? 'asking' : 'none',
    error: last_error
      ? { code: last_error.code, message: last_error.message, at: new Date(last_error.at).toISOString() }
      : null,
  };
}

// What api.js reads for the update row and the settings page, without asking again.
const seen_me = () => ({ last_me, last_me_at, last_campaign });

module.exports = { me, refresh_account, link_start, link_status, sign_out, campaign, account_view, seen_me };
