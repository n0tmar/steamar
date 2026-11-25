'use strict';

// Every /api route the engine answers, as one table: "METHOD /path" -> handler(req, url).
// A handler returns the JSON reply or throws; server.js does the HTTP around it.
// It is not where the work lives: handlers read the request and call the module that owns the job.
// Trap: test/wire.test.js reads this file as text to check the page calls nothing unanswered, so a
// route key must stay a plain 'METHOD /api/...' string.

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const paths = require('./paths');
const api = require('./api');
const catalog = require('./catalog');
const { SHELVES } = require('./home');
const images = require('./images');
const denuvo = require('./denuvo');
const setup = require('./setup');
const vendor = require('./vendor');
const update = require('./update');
const repair = require('./repair');
const onlinefix = require('./onlinefix');
const scan = require('./scan');
const { add_app, remove_app, restore_backup } = require('./library');
const { stop_steam, restart_steam, steam_open } = require('./steam');
const { open_link, put_clipboard, pick_folder, folder_for, reveal } = require('./desktop');
const { reach, settings_view, pull_repos, selftest, status, names, library_view } = require('./views');
const { bad_request, not_found } = require('./errors');

function read_body(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 1_000_000) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

// A promise with a deadline, for the calls a render should never wait on. The timer is unref'd so a
// pending deadline never keeps the process alive, and the fallback is what the caller gets if the
// answer arrives too late - which, for a search page, is "no verdict" rather than "no results".
function with_deadline(promise, ms, fallback) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    if (timer.unref) timer.unref();
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      () => { clearTimeout(timer); resolve(fallback); },
    );
  });
}

// The Denuvo list and the fix index are for members, so a PC that was signed out (or not yet in the
// server) when the engine started was refused both, and used to wait for the next start. Once the
// account says somebody is in, a list that never arrived is asked for again.
function catch_up(account) {
  if (!account || !account.linked || account.tier === 'none') return;
  if (!denuvo.stats().loaded_at) denuvo.hydrate().catch(() => {});
  if (!onlinefix.load().items.length) onlinefix.hydrate().catch(() => {});
}

// A newer build is fetched at start, while the person works. Nothing is replaced: the swap still
// needs the window to close, and the chip in the rail is the press that asks for it. A stage left by
// an earlier run counts as fetched, so a restart does not download the same 34 MB again.
function fetch_new() {
  const channel = api.state().update || {};
  if (channel.state !== 'optional' && channel.state !== 'required') return null;
  const job = update.state();
  if (['downloading', 'verifying', 'unpacking', 'ready'].includes(job.state)) return job;
  return update.start({ url: channel.url, sha256: channel.sha256, version: channel.version }).catch(() => null);
}

const routes = {
  'GET /api/status': () => status(),
  'GET /api/setup': () => setup.state(),
  'POST /api/setup/install': async (req) => {
    const body = await read_body(req);
    return setup.install(body.folder);
  },
  'POST /api/setup/remove': async () => setup.remove(),
  // Starts the download in the background and answers at once; /api/setup carries the progress.
  // A 16 MB game list must not sit in an open request behind the bridge.
  'POST /api/setup/fetch': async (req) => {
    const body = await read_body(req);
    return vendor.start(Boolean(body && body.force));
  },
  'POST /api/pick-folder': async (req) => {
    const body = await read_body(req);
    // The page names the row; the folder comes from config so the dialog starts where it should.
    const start = body.start || folder_for(body.key);
    return { folder: await pick_folder(body.title || 'Choose a folder', start) };
  },
  'GET /api/library': async () => library_view(),
  'GET /api/settings': async () => settings_view(),
  // One title's pre-flight, for a panel that was not opened from a search row: a deep link, the
  // library, the fixes list. Same gate as the grid, one call, no depot list in the reply.
  'GET /api/verdict': async (req, url) => {
    const appid = String(url.searchParams.get('appid') || '');
    if (!/^\d{1,12}$/.test(appid)) throw bad_request('appid must be digits');
    const answer = await api.verdicts([appid]).catch(() => null);
    return (answer && answer.verdicts && answer.verdicts[appid]) || null;
  },
  // The person pressing check. It is the same question the boot asks, with the cache skipped:
  // an answer kept for twelve hours is not what a button called check means.
  'POST /api/update-check': async () => {
    await api.latest(true);
    return { update: api.state().update };
  },

  /* ---------- updating in place ---------- */

  // Downloading is a job, not a request: a 34 MB file behind the 30-second bridge limit would look
  // like a hang. The POST starts it, the GET is what the row polls, and nothing here touches a file
  // the service signed for until its checksum matches.
  'GET /api/update': () => update.state(),

  'POST /api/update': async () => {
    let current = api.state().update || {};
    // The button can be pressed on a twelve-hour-old answer; ask once more before moving 34 MB.
    if (current.state !== 'optional' && current.state !== 'required') {
      await api.latest(true);
      current = api.state().update || {};
    }
    if (current.state !== 'optional' && current.state !== 'required') {
      throw bad_request('this is the newest build the service has');
    }
    update.start({ url: current.url, sha256: current.sha256, version: current.version }).catch(() => null);
    return update.state();
  },

  // The swap itself belongs to the shell: only the window can start a process that outlives it, and
  // only the window can close so the files can be replaced. A browser tab is told the truth instead
  // of being handed a button that cannot work.
  'POST /api/update/apply': () => {
    throw bad_request('this copy has no window to restart - unpack out/update/stage by hand, or download the release');
  },

  /* ---------- who is using this PC ---------- */

  // Who is using this PC. The window cannot choose between the app and the door without this, so a
  // cold start kicks the question off in the background and the screen asks again a moment later.
  // `force` is a person pressing "check again", or the window coming back to the front after a
  // donation or a new role: it waits for the fresh answer (a few seconds at most) instead of handing
  // back the one from before the question.
  'GET /api/account': async (req, url) => {
    const force = url.searchParams.get('force') === '1';
    const asking = api.refresh_account({ force }).catch(() => null);
    if (force) await with_deadline(asking, 6000, null);
    const state = api.state();
    catch_up(state.account);
    return {
      account: state.account,
      campaign: state.campaign,
      base: api.base_url(),
      site: api.site_url(),
      // A build with no pinned key has no door to open: the window says so instead of drawing a
      // sign-in button that cannot work.
      configured: state.configured,
      enrolled: state.enrolled,
    };
  },

  // Signing in: ask the service for a code, hand the url to the real browser, and let the page there
  // do the login. The WebView never sees discord.com and never holds a token.
  'POST /api/login': async () => {
    const start = await api.link_start();
    if (start && start.url) open_link(start.url);
    return { code: start.code, url: start.url, expires_in: start.expires_in, opened: Boolean(start.url) };
  },

  // The poll behind that. `done` means this PC now carries a person; refresh the identity and answer
  // with the account so the panel can redraw in one repaint.
  'GET /api/login/status': async (req, url) => {
    const code = String(url.searchParams.get('code') || '');
    if (!code) throw bad_request('a code is required');
    const answer = await api.link_status(code);
    if (answer && answer.state === 'done') await api.me().catch(() => null);
    return { status: answer ? answer.state : 'expired', user: answer?.user || null, account: api.account_view() };
  },

  // Give: the page is on the site, not in this window, because a payment form inside a WebView is a
  // payment form nobody should have to trust.
  'POST /api/donate': async () => {
    const url = `${api.site_url()}/donate`;
    open_link(url);
    return { opened: url };
  },

  // Your public page on the site (steamar.cc/@username), or the editor for it (/account/profile).
  'POST /api/profile': async (req) => {
    const account = api.account_view();
    const name = account && account.linked && account.user ? account.user.username : '';
    if (!name) throw bad_request('Sign in first.');
    const body = await read_body(req);
    const page = account.profile || {};
    // A connection is asked for by its place in the person's own list, so the window never hands the
    // engine an address; open_link still refuses anything that is not https.
    if (body.link !== undefined) {
      const link = Array.isArray(page.links) && Number.isInteger(body.link) ? page.links[body.link] : null;
      if (!link) throw bad_request('That link is not on your page any more.');
      open_link(link.url);
      return { opened: link.url };
    }
    // The page's own address: a bought name or the owner's @1 is not the Discord name.
    const url = body.edit ? `${api.site_url()}/account/profile` : page.url || `${api.site_url()}/@${encodeURIComponent(name)}`;
    open_link(url);
    return { opened: url };
  },

  // Sign this PC out. The answer is the fresh account, which now says "not signed in", so the window
  // can draw the sign-in screen from it without asking again.
  'POST /api/logout': async () => {
    await api.sign_out();
    return { account: api.state().account };
  },

  // The month, refreshed on demand: the paused screen's "check again", and the pill's source.
  'POST /api/campaign': async () => {
    const campaign = await api.campaign({ force: true }).catch(() => null);
    return { campaign: campaign || api.state().campaign };
  },
  // The checkup: what is missing, what is from another tool, what does not parse, and one route
  // that puts it right. Fixes are local file work, so they answer with what actually happened.
  'GET /api/repair': async () => repair.inspect(),
  'POST /api/repair': async (req) => {
    const body = (await read_body(req)) || {};
    // Closing Steam is part of the repair, not a chore handed back to the person: the proxy files
    // are loaded at boot and Windows holds them open. `restart` puts Steam back afterwards, which
    // is what someone who was using it expects; during a first-run setup it stays closed so the
    // next step can copy the files in.
    const was_running = paths.steam_running(true);
    let closed_by_us = false;
    if (was_running) {
      if (!body.close_steam) {
        // Not an engine failure: the answer is "press the button that can close Steam".
        const denied = new Error('close Steam first, then repair');
        denied.status = 400;
        throw denied;
      }
      if (!(await stop_steam())) {
        const stuck = new Error('Steam did not close. a game may be running, so close Steam and press fix again.');
        stuck.status = 400;
        throw stuck;
      }
      closed_by_us = true;
    }
    const result = repair.fix(body.only || null);
    if (closed_by_us && body.restart !== false) {
      const exe = path.join(paths.steam_root(), 'steam.exe');
      if (paths.exists(exe)) {
        paths.steam_running(true);
        spawn(exe, ['-silent'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      }
    }
    return result;
  },
  'GET /api/search': async (req, url) => {
    const term = url.searchParams.get('q') || '';
    // The store search cannot see delisted or region-locked apps, which are the ones worth
    // adding, so the service's title index is merged in after it. A service that is down costs the
    // extra titles, not the search: the store's own results still answer.
    const store = await catalog.search_store(term).catch(() => []);
    // Results are cards on a page of their own, so they carry the same wide art as every other card.
    const results = store.map((r) => ({
      ...r,
      image: images.url(r.appid),
      denuvo: denuvo.has(r.appid, r.name),
    }));
    const seen = new Set(results.map((r) => r.appid));
    const extra = await api.search(term, 12).then((r) => r?.results || []).catch(() => []);
    for (const hit of extra) {
      if (seen.has(hit.appid)) continue;
      seen.add(hit.appid);
      results.push({
        appid: hit.appid,
        name: hit.name,
        image: images.url(hit.appid),
        platforms: {},
        denuvo: denuvo.has(hit.appid, hit.name),
        supplier: true,
      });
    }

    // Pre-flight, one call for the whole page: every card learns whether it can be written before
    // it is clicked, not after. The service answers with a boolean and a sentence and nothing else,
    // so this costs one cheap request instead of a package read per row.
    //
    // A row with no verdict is left as it was: the service holding no opinion is not the same as
    // "no". The add itself still refuses a title it cannot write, and says why. The deadline is
    // short on purpose - a slow service costs the verdicts, never the search.
    const asked = results.map((r) => r.appid);
    // Which of them Steam took off its store, asked at the same time and under the same deadline. A
    // hit from the service's index is not removed by being there: Steam's search answers ten at most.
    const [verdicts, gone] = await Promise.all([
      with_deadline(api.verdicts(asked).then((answer) => answer?.verdicts || {}), 1500, {}),
      with_deadline(catalog.removed_from_store(asked), 1500, new Set()),
    ]);
    for (const row of results) if (gone.has(row.appid)) row.removed = true;
    for (const row of results) {
      const verdict = verdicts[row.appid];
      if (!verdict) continue;
      row.renderable = verdict.renderable;
      row.partial = Boolean(verdict.partial);
      row.reason = verdict.reason || null;
      // What other machines hit on this title. Absent until somebody reports; when it is there the
      // card says it, because "two of five attempts failed" is the reason a person hesitates and
      // the reason they should not have to find out the hard way.
      const seen = verdict.report;
      row.reports = seen && Number(seen.total) > 0
        ? { total: Number(seen.total) || 0, fails: Number(seen.fails) || 0, last_outcome: seen.last_outcome || null }
        : null;
    }

    return { results };
  },
  'GET /api/store': async () => {
    const art = (r) => ({
      ...r,
      image: images.url(r.appid),
      hero: images.hero(r.appid),
      denuvo: denuvo.has(r.appid, r.name),
    });

    // The games the owner picked lead Home: a shelf of their own, and the first claim on the banner.
    // They come signed inside the account answer, so a saved copy shows them before the service does.
    const home = api.account_view().home || {};
    const picks = (Array.isArray(home.picks) ? home.picks : [])
      .filter((p) => p && /^\d{1,12}$/.test(String(p.appid)))
      .map((p) => ({ appid: String(p.appid), name: p.name || `App ${p.appid}` }));

    // A slide needs a real wide asset, and that is an HTTP probe: done one after another, four
    // probes held the whole shelf for as long as their timeouts added up. They are independent
    // questions, so they are asked at once and the shelf waits for the slowest, not the sum.
    // Without picks, the banner is the head of each of the owner's shelves.
    const heads = SHELVES.flatMap((shelf) => shelf.games.slice(0, 2));
    const pool = [...picks, ...heads]
      .filter((item, i, all) => all.findIndex((other) => String(other.appid) === String(item.appid)) === i);
    // Four slides when the shelves fill the banner; as many as the owner picked (the console allows 12).
    const slides = Math.max(4, picks.length);
    const probes = pool.slice(0, slides + 4);
    // A pick carries the service's title-index name, which is sometimes not English (Elden Ring came
    // back in Chinese). The store's own English name wins; it is cached on disk after the first ask.
    const [wide, english] = await Promise.all([
      Promise.all(probes.map((item) => images.hero_available(item.appid))),
      Promise.all(picks.map((p) => catalog.app_lookup(p.appid).then((hit) => hit && hit.name).catch(() => null))),
    ]);
    const name_of = new Map(picks.map((p, i) => [p.appid, english[i] || p.name]));
    const named = (r) => (name_of.has(String(r.appid)) ? { ...r, name: name_of.get(String(r.appid)) } : r);
    const with_hero = probes.filter((_, i) => wide[i]);
    const banner = with_hero.length >= 3 ? with_hero.slice(0, slides) : pool.slice(0, slides);

    return {
      denuvo_count: denuvo.stats().count,
      banner: banner.map(named).map(art),
      picks: picks.map(named).map(art),
      shelves: SHELVES.map((shelf) => ({ title: shelf.title, games: shelf.games.map(art) })),
    };
  },
  'GET /api/package': async (req, url) => catalog.resolve_package(url.searchParams.get('appid') || ''),
  'GET /api/app': async (req, url) => {
    const appid = String(url.searchParams.get('appid') || '');
    // Same rule as every other appid route: a non-numeric id is a caller bug, not a missing app.
    if (!/^\d{1,12}$/.test(appid)) throw bad_request('appid must be digits');
    const details = await catalog.app_details(appid);
    // The shell rewrites "/img/ inside a JSON body to the engine's own address, so the panel gets a
    // working cover from here. The page cannot build that path itself.
    // Denuvo is not in the store's answer at all: it is matched against the app's own list, by id or
    // by name, so the panel can show the same chip a card shows.
    // The wide hero is the panel's picture when Steam has one; the cover stays under it until it lands.
    return details.missing ? details
      : { ...details, denuvo: denuvo.has(details.appid, details.name), image: images.url(details.appid), hero: images.hero(details.appid) };
  },
  'GET /api/reach': async () => reach(),
  // --- fixes catalogue: index read, disk state, and the one link to open -----------------------
  // Asked each time the tab opens. A copy younger than an hour is a disk read; an older one is fetched,
  // and the tab waits a moment for it. With no copy at all it waits longer rather than say "none".
  'GET /api/fixes': async (req, url) => {
    const empty = !onlinefix.load().items.length;
    await with_deadline(onlinefix.hydrate(), empty ? 8000 : 1500, null);
    // `asking` says the list is still on its way, so an empty answer is drawn as loading, not as
    // "check your connection", and the tab asks again instead of giving up.
    return { ...onlinefix.view({ limit: Number(url.searchParams.get('limit') || 200) }), asking: onlinefix.busy() };
  },
  'GET /api/fixes/scan': async () => ({ rows: scan.scan_common(), common: scan.common_dirs() }),
  // The fix file a release points at. The service resolves it and keeps the answer; this side asks
  // by release id and never sees how a mirror is unpacked. `onlinefix.link_for` adds the mirror.
  'GET /api/fixes/link': async (req, url) => {
    const id = url.searchParams.get('id');
    const entry = onlinefix.find(id);
    if (!entry) throw not_found('unknown release');
    const link = await api.fix_link(entry.id);
    // The click just told us this release does carry a fix of its own. Keep the answer and the
    // file name so the list gets better with use instead of asking the same question again.
    onlinefix.remember(entry.id, link);
    return { link };
  },
  'GET /api/names': async (req, url) => names((url.searchParams.get('ids') || '').split(',').filter(Boolean)),
  'POST /api/add': async (req) => {
    const b = await read_body(req);
    // The report is the loop the service could not close on its own: which titles work, on which
    // build, and which ones stall. It is sent on both paths and never awaited - a failure to report
    // must not become a failure to add.
    try {
      const result = await add_app(b.appid, b.file);
      api.report({
        appid: b.appid,
        // A script with no keys is written and installs nothing: that is a stall, not a success,
        // and counting it as one is how a rotten title stays in the catalogue.
        outcome: result.keys > 0 ? 'added' : 'stalled',
        detail: result.keys > 0 ? null : `${result.depots} depots, 0 keys`,
      });
      return result;
    } catch (err) {
      api.report({ appid: b.appid, outcome: 'error', detail: err.message });
      throw err;
    }
  },
  'POST /api/remove': async (req) => remove_app(await read_body(req)),
  'POST /api/restore': async (req) => restore_backup((await read_body(req)).file),
  'POST /api/settings': async (req) => {
    const body = await read_body(req);
    paths.set_paths({
      steam_root: body.steam_root,
      stplug_in: body.stplug_in,
      depotcache: body.depotcache,
      dll_source: body.dll_source,
    });
    return settings_view();
  },
  'POST /api/cache/clear': async () => {
    fs.rmSync(path.join(paths.out_dir(), 'cache'), { recursive: true, force: true });
    fs.rmSync(path.join(paths.out_dir(), 'imgcache'), { recursive: true, force: true });
    // The mirrors go too, so the next call is a real one: this is the button for "ask the service
    // again", and it must not leave yesterday's answer sitting in front of it.
    api.reset();
    return { cleared: true };
  },
  // The shell answers this itself; a browser keeps parity by writing the same line to the console.
  'POST /api/log': async (req) => {
    const body = await read_body(req);
    const level = String(body.level || 'log').slice(0, 20);
    const message = String(body.message || '').slice(0, 2000).replace(/\s*\n\s*/g, ' | ');
    console.error(`ui.${level}: ${message}`);
    return { logged: true };
  },
  'POST /api/pull': async () => pull_repos(),
  'POST /api/reveal': async (req) => reveal((await read_body(req)).target),
  'POST /api/open-link': async (req) => open_link((await read_body(req)).url),
  'POST /api/clipboard': async (req) => put_clipboard(String((await read_body(req)).text || '')),
  'GET /api/selftest': async () => selftest(),
  'POST /api/install': async (req) => {
    const body = await read_body(req);
    return steam_open(body.appid, body.action);
  },
  'POST /api/steam/restart': async () => restart_steam(),
};

module.exports = { routes, fetch_new };
