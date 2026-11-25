'use strict';

// Renders every view through dom.js from recorded answers in test/fixtures/views/payloads.json.
// It needs no browser and no engine, except with --record, which rewrites the fixtures from --base.
// Trap: never edit the fixtures by hand; a hand-made fixture agrees with the page and proves nothing.

// Every view, drawn from a real answer, without a browser.
//
// The page has eight renderers and only the door was ever read: the library, the shelves, the fixes
// list, settings and the drawer were checked by opening the app and looking, which is not a check
// and is not reproducible on the machine that has no WebView2. So this loads the page against a stub
// DOM, answers its calls from fixtures captured from a real engine, walks every route, and fails on
// the three things a view can get wrong: it cannot draw from the data it is given, it prints
// `undefined` where a fact should be, or it says something the data does not support.
//
//   node tools/check-views.js
//   node tools/check-views.js --record --base http://127.0.0.1:8788   (rewrite the fixtures)
//
// The fixtures are a real engine's answers, refreshed on purpose rather than invented here: a fixture
// written by hand agrees with the page and proves nothing.

const fs = require('node:fs');
const path = require('node:path');
const dom = require('./dom');

const ROOT = path.join(__dirname, '..');
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'views', 'payloads.json');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const argv = process.argv.slice(2);
const record = argv.includes('--record');
const base = (argv.includes('--base') ? argv[argv.indexOf('--base') + 1] : 'http://127.0.0.1:8788').replace(/\/$/, '');

let problems = 0;
let total = 0;
const check = (label, got, want) => {
  total += 1;
  const pass = JSON.stringify(got) === JSON.stringify(want);
  if (!pass) problems += 1;
  console.log(`  ${pass ? 'ok  ' : 'FAIL'}  ${label}${pass ? '' : `: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
};
const has = (label, text, needle) => check(label, String(text).includes(needle), true);
const hasnt = (label, text, needle) => check(label, String(text).includes(needle), false);
const count_of = (text, needle) => String(text).split(needle).length - 1;

/* ---------- the answers, captured or replayed ---------- */

// The answers come from a real machine, and a real machine has a person in it. The shape is kept and
// the person is not: an address, a Discord id, a device id and an avatar hash are the four things a
// fixture has no use for, and a fixture nobody minds reading is one that stays honest.
const REDACT = {
  email: 'someone@example.invalid',
  discord_id: '000000000000000000',
  device_id: 'dev_fixture',
  avatar: 'fixture',
  avatar_url: 'https://cdn.discordapp.com/avatars/0/fixture.png',
};

function scrub(value) {
  if (Array.isArray(value)) return value.map(scrub);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, inner] of Object.entries(value)) out[key] = key in REDACT ? REDACT[key] : scrub(inner);
  return out;
}

// The fixes index is 1,900 rows and about a megabyte, and this check is about the drawing rather than
// the length of the shelf: sixty rows is more than any view can draw at once.
function trim(route, body) {
  if (route.startsWith('/api/fixes') && Array.isArray(body.rows) && body.rows.length > 60) {
    return { ...body, rows: body.rows.slice(0, 60), rows_kept: 60 };
  }
  return body;
}

const known = record ? new Map() : new Map(Object.entries(JSON.parse(fs.readFileSync(FIXTURE, 'utf8'))));
const missing = new Set();
const pending = new Set();

async function answer(url) {
  const route = String(url).replace(/^https?:\/\/[^/]+/, '');
  if (record) {
    const res = await fetch(base + route, { signal: AbortSignal.timeout(30000) });
    const body = trim(route, scrub(await res.json()));
    known.set(route, body);
    return { status: res.status, body };
  }
  if (!known.has(route)) {
    // A route the page asks for and the fixture set does not hold: the fixture is out of date, and
    // that is a finding, not a reason to invent an answer.
    const loose = [...known.keys()].find((key) => key.split('?')[0] === route.split('?')[0]);
    if (!loose) {
      missing.add(route);
      return { status: 404, body: { error: { code: 'no_fixture', message: `no fixture for ${route}` } } };
    }
    return { status: 200, body: known.get(loose) };
  }
  return { status: 200, body: known.get(route) };
}

function fetch_stub(url, options = {}) {
  const job = (async () => {
    const { status, body } = await answer(url);
    const text = JSON.stringify(body);
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: String(status),
      headers: { get: (name) => (String(name).toLowerCase() === 'content-type' ? 'application/json' : null) },
      json: async () => JSON.parse(text),
      text: async () => text,
    };
  })();
  pending.add(job);
  job.catch(() => null).finally(() => pending.delete(job));
  return job;
}

// The page does not await everything it starts (the shelves arrive after the first paint, by
// design), so the check waits for the calls it can see instead of sleeping and hoping.
async function settle() {
  for (let i = 0; i < 60; i++) {
    if (pending.size) {
      await Promise.allSettled([...pending]);
      continue;
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
    if (!pending.size) return;
  }
}

/* ---------- the page ---------- */

const location = { hash: '#/home', href: 'http://127.0.0.1:8788/index.html' };
const storage = { getItem: () => null, setItem() {}, removeItem() {} };

const ui = new Function(
  'window', 'document', 'fetch', 'navigator', 'sessionStorage', 'localStorage', 'setTimeout',
  'setInterval', 'clearTimeout', 'clearInterval', 'location',
  `${dom.page_source(path.join(ROOT, 'ui'))}
; return { state, route, render_home, render_library, render_fixes, paint_fixes, render_settings, render_setup, open_account, open_drawer, close_drawer, card_html, toggle_search_show, boot };`,
)(
  dom.window_stub(),
  dom.document,
  fetch_stub,
  { userAgent: 'steamarc-check' },
  storage,
  storage,
  setTimeout,
  dom.noop_timer,   // a banner that rotates forever would never let the check finish
  clearTimeout,
  dom.noop_timer,
  location,
);

const node = dom.node;

/* ---------- the three things a view can get wrong ---------- */

function drawn(html) {
  const faults = [];
  if (!html.trim()) faults.push('nothing was drawn');
  for (const [what, pattern] of [
    ['undefined', /\bundefined\b/],
    ['NaN', /\bNaN\b/],
    ['[object Object]', /\[object Object\]/],
    ['null in an attribute', /="null"/],
  ]) {
    if (pattern.test(html)) faults.push(`${what} appears in the markup`);
  }
  return { html, faults };
}

function report_html(label, html) {
  const { faults } = drawn(html);
  check(`${label} draws something`, html.trim().length > 0, true);
  check(`${label} has no undefined, NaN or [object Object]`, faults, []);
  return html;
}

const report = (label, view) => report_html(label, node(view).innerHTML);

/* ---------- the walk ---------- */

(async () => {
  // The app boots itself: account, then everything behind the door. A member who is in the server is
  // the state every view below is meant to be read in.
  await settle();

  const account = ui.state.account;
  check('the fixture signs a member in', Boolean(account && account.linked), true);
  check('so the door is open', Boolean(account && account.tier !== 'none'), true);

  // What the boot path asks for on its own. The fixes index is not in this list: it is read when that
  // view is opened, so it exists in the fixture set only after the walk below has reached it.
  const lib = known.get('/api/library');
  const status = known.get('/api/status');
  const store = known.get('/api/store');
  const settings = known.get('/api/settings');
  if (!record && (!lib || !status || !store || !settings)) {
    console.error('\nthe fixtures are incomplete - run again with --record against a live engine');
    process.exit(1);
  }
  const games = (lib && lib.games) || [];

  console.log('\nthe status bar');
  const bar = report('the status bar', 'statusbar');
  has('it counts the scripts the engine counted', bar, `${status.scripts} in library`);
  has('and says whether Steam is up', bar, `Steam ${status.steam_running ? 'running' : 'closed'}`);

  console.log('\nthe library');
  location.hash = '#/library';
  await ui.route();
  await settle();
  const library = report('the library', 'view-library');
  for (const game of games) has(`app ${game.appid} is on the shelf`, library, `data-appid="${game.appid}"`);
  const installed = games.filter((g) => g.installed).length;
  const keyless = games.filter((g) => g.keyless && !g.installed).length;
  if (installed) has('the shelf counts what Steam has', library, `${installed} installed`);
  else hasnt('nothing is claimed to be installed', library, ' installed');
  check('a no-key script is marked once each', count_of(library, "Can't download yet</span>"), keyless);
  // The count in the note bar says "3 installed" too, so the tag is counted by its own span rather
  // than by the word: a marker that appears twice for one game would pass a word count.
  check('an installed title is marked once each', count_of(library, '<span class="state ok">'), installed);

  console.log('\nthe shelves');
  location.hash = '#/home';
  await ui.route();
  await settle();
  ui.render_home();
  const home = report('home', 'view-home');
  for (const slide of (store.banner || []).slice(0, 4)) has(`slide "${slide.name.slice(0, 24)}" is drawn`, home, `data-appid="${slide.appid}"`);
  const shelved = (store.shelves || []).reduce((n, shelf) => n + shelf.games.length, 0);
  check('every shelf has cards', count_of(home, 'class="card'), shelved);
  for (const shelf of store.shelves || []) has(`the shelf "${shelf.title}" is drawn`, home, `<h3>${shelf.title}</h3>`);

  // The owner's picks lead the banner (the engine puts them first); they are not a shelf of their own.
  const picked = store.shelves[0].games.slice(0, 2).map((g) => ({ ...g, appid: `9${g.appid}`, name: `Picked ${g.name}` }));
  ui.state.store = { ...store, picks: picked };
  ui.render_home();
  const featured = report('home with picks', 'view-home');
  hasnt('the picks are not a shelf of their own', featured, '>Featured<');
  check('so the shelves are only the owner\'s list', count_of(featured, 'class="card'), shelved);
  ui.state.store = store;
  ui.render_home();

  console.log('\nthe search');
  location.hash = '#/search?q=resident';
  await ui.route();
  await settle();
  const found = report('the search page', 'view-search');
  const results = (known.get('/api/search?q=resident') || {}).results || [];
  // Not available and removed from Steam are hidden until their switch is on; the library's own never are.
  const mine = (r) => games.some((g) => g.kind === 'game' && g.appid === r.appid);
  const unavailable = results.filter((r) => r.renderable === false && !mine(r)).length;
  const removed = results.filter((r) => r.renderable !== false && r.removed && !mine(r)).length;
  const usable = results.length - unavailable - removed;
  check('by default only what can be added is a card', count_of(found, 'class="card'), usable);
  has('and the page says how many', found, `${usable} result${usable === 1 ? '' : 's'} for`);
  if (unavailable + removed) has('and how many it hid', found, `${unavailable + removed} hidden`);
  ui.toggle_search_show('unavailable');
  ui.toggle_search_show('removed');
  const all = report('the search page with both switches on', 'view-search');
  check('both switches on show every result', count_of(all, 'class="card'), results.length);
  check('a title with nothing to add says not available', count_of(all, 'class="mark bad" role="img" aria-label="Not available'), unavailable);
  check('a title off the store says removed from steam', count_of(all, 'class="mark off" role="img" aria-label="Removed from Steam'), removed);
  ui.toggle_search_show('unavailable');
  ui.toggle_search_show('removed');

  console.log('\nthe fixes');
  location.hash = '#/fixes';
  await ui.route();
  await settle();
  const fix_view = report('the fixes list', 'view-fixes');
  const fixes = known.get('/api/fixes?limit=4000') || known.get('/api/fixes?limit=5') || {};
  has('the index size is stated', fix_view, Number(fixes.total).toLocaleString());
  const first = (fixes.rows || []).find((row) => row.title);
  if (first) has('and a real release is on it', fix_view, first.title.slice(0, 12));

  // A cover that fails tries the next picture on its own list before it gives up and shows the name.
  const handler = (fix_view.match(/<img [^>]*data-alt="[^"]+"[^>]*onerror="([^"]+)"/) || [])[1];
  if (handler) {
    const parent = { dataset: {}, classes: [], classList: { add(name) { parent.classes.push(name); } } };
    const img = { dataset: { alt: '/img/a.jpg /img/b.jpg' }, parentNode: parent, src: '', removed: false, remove() { this.removed = true; } };
    const fail = new Function(handler);
    fail.call(img);
    const tried = [img.src];
    fail.call(img);
    tried.push(img.src);
    fail.call(img);
    check('a broken cover tries the next picture, then the one after', tried, ['/img/a.jpg', '/img/b.jpg']);
    check('and only then shows the name instead', [parent.classes.includes('noart'), img.removed], [true, true]);
  } else {
    check('a fix with a cover has pictures to fall back on', false, true);
  }

  // A first download that is still on its way is drawn as loading, not as a connection problem.
  ui.paint_fixes({ total: 0, rows: [], asking: true, fetched: null });
  const waiting = node('view-fixes').innerHTML;
  check('a list still on its way shows the loading rows', waiting.includes('sk-row'), true);
  hasnt('and does not blame the connection', waiting, 'internet connection');
  ui.paint_fixes({ total: 0, rows: [], asking: false, fetched: null });
  has('a list that never came says so', node('view-fixes').innerHTML, 'internet connection');

  // A long list draws its first rows with the page, and the next ones only as its end comes near.
  const watchers = [];
  globalThis.IntersectionObserver = class {
    constructor(seen) { this.seen = seen; watchers.push(this); }
    observe(el) { this.el = el; }
    unobserve() { this.el = null; }
    disconnect() { this.el = null; }
  };
  const old = { ...fixes.rows[0], in_library: false, trending: false, local: null, posted_at: '2020-01-01T00:00:00Z' };
  ui.paint_fixes({ ...fixes, total: 500, rows: Array.from({ length: 500 }, (_, i) => ({ ...old, id: `long-${i}` })) });
  const rows_in = (html) => (String(html || '').match(/data-fix-row=/g) || []).length;
  check('a long list draws only its first rows', rows_in(node('view-fixes').innerHTML), 60);
  has('and marks where the rest goes', node('view-fixes').innerHTML, 'id="fixtail"');
  const watcher = watchers[watchers.length - 1];
  watcher.seen([{ isIntersecting: true }]);
  check('the next rows arrive when the end comes near', rows_in(node('fixtail').adjacent), 120);
  check('and it keeps watching while rows are left', Boolean(watcher.el), true);
  delete globalThis.IntersectionObserver;
  ui.paint_fixes(fixes);

  console.log('\nthe settings');
  location.hash = '#/settings';
  await ui.route();
  await settle();
  const panel = report('settings', 'view-settings');
  has('the build says which build it is', panel, `v${settings.app.version}`);
  has('and the Steam folder it found', panel, String(settings.steam.root));

  // A build the service refuses is not an outage, and it must not read as "unknown": the row has one
  // line for it, and no button it cannot make good on.
  const was_update = ui.state.settings.app.update;
  ui.state.settings.app.update = {
    state: 'required',
    version: '9.0.0',
    url: null,
    sha256: null,
    notes: 'nothing is answered until this build is replaced',
    checked_at: new Date().toISOString(),
  };
  ui.render_settings();
  const floor_panel = report('an old build', 'view-settings');
  has('an old build is told so', floor_panel, 'Update required');
  has('and what that costs', floor_panel, 'Update to keep using SteaMar');
  hasnt('with no update button it cannot honour', floor_panel, 'data-act="update"');
  ui.state.settings.app.update = was_update;
  ui.render_settings();
  hasnt('the account is not a settings group', report('settings', 'view-settings'), '<h3>Account</h3>');

  console.log('\nthe account window');
  const was_account = ui.state.account;
  ui.state.account = {
    known: true, linked: true, tier: 'donor', paused: null, pass: null,
    user: { username: 'owner', global_name: 'Owner', avatar_url: null, joined_server: '2025-12-19T16:06:26Z', donor_since: '2026-11-03T10:00:00Z', donations: { count: 2 } },
    profile: {
      url: 'https://steamar.cc/@k', handle: 'k', hidden: false, owner: false, background: { preset: 'dusk' }, banner: null,
      avatar: { image_url: 'http://127.0.0.1:8788/img/site/profile/eeeeeeeeeeeeeeeeeeeeeeee.gif' },
      frame: 'heartbloom', frame_url: 'http://127.0.0.1:8788/img/site/frames/heartbloom.gif', marks: { owner: 'http://127.0.0.1:8788/img/site/badges/448267-droolingcatking.png', donor: 'http://127.0.0.1:8788/img/site/badges/95458-heart.gif' },
      bio: 'Building things <b>here</b>.', pronouns: 'he/him', status: { kind: 'dnd', text: 'in a raid' },
      links: [{ kind: 'github', url: 'https://github.com/owner' }, { kind: 'myspace', url: 'https://myspace.com/owner' }],
    },
  };
  ui.open_account();
  const acct = report('the account window', 'dialog');
  has('it names the person', acct, '>Owner<');
  has('their own picture, through the engine, as a GIF', acct, 'src="http://127.0.0.1:8788/img/site/profile/eeeeeeeeeeeeeeeeeeeeeeee.gif"');
  has('by the name of their page, not their Discord name', acct, '>@k<');
  has('and their role, as the mark the page shows', acct, 'data-tip="Donor - keeps SteaMar online"');
  has('drawn from the address the engine gave', acct, 'src="http://127.0.0.1:8788/img/site/badges/95458-heart.gif"');
  has('with the frame their page wears', acct, '/img/site/frames/heartbloom.gif');
  has('and their status on the picture', acct, 'acct-status is-dnd');
  has('and what it says, beside it', acct, '>in a raid<');
  has('their pronouns after the handle', acct, '>he/him<');
  has('their About me, as text', acct, 'Building things &lt;b&gt;here&lt;/b&gt;.');
  has('and their links, asked for by their place in the list', acct, 'data-act="profile-link" data-link="1"');
  hasnt('never by an address the window hands over', acct, 'https://github.com/owner');
  has('a site the window has no mark for still shows, as a link', acct, 'title="Link"');
  has('since when they are in the server', acct, 'Member since December 2025');
  has('and since when they give', acct, 'Donor since November 2026 · 2 donations');
  has('on their own page background', acct, 'acct-banner bg-dusk');
  has('with the link to their page, as it is shared', acct, '>steamar.cc/@k<');
  has('and a way to copy it', acct, 'data-act="profile-copy"');
  has('with a way to sign this PC out', acct, 'data-act="logout"');
  has('and to donate', acct, 'data-act="donate"');
  has('with their public page', acct, 'data-act="profile-view"');
  has('and its editor', acct, 'data-act="profile-edit"');
  ui.state.account = { ...ui.state.account, profile: { url: 'https://steamar.cc/@owner', background: { image_url: "https://steamar.cc/v1/profile/image?f=a.jpg');x:url('evil" } } };
  ui.open_account();
  hasnt('a picture address cannot break out of its style', report('the account window', 'dialog'), "');x:url(");
  ui.state.account = { ...ui.state.account, profile: { url: 'https://steamar.cc/@owner', owner: true, background: { preset: 'dusk' }, banner: { image_url: 'https://steamar.cc/v1/profile/image?f=top.jpg' }, frame: '../x', frame_url: 'http://127.0.0.1:8788/img/site/frames/../x.gif', marks: { owner: 'http://127.0.0.1:8788/img/site/badges/448267-droolingcatking.png', donor: 'http://127.0.0.1:8788/img/site/badges/95458-heart.gif' }, status: { kind: 'evil' } } };
  ui.open_account();
  const owned = report('the account window', 'dialog');
  has('the banner picture leads, over the background', owned, "acct-banner is-image\" style=\"background-image:url('https://steamar.cc/v1/profile/image?f=top.jpg')");
  has('the owner wears the mark of their own', owned, 'data-tip="Runs SteaMar"');
  has('the cat, not the heart', owned, 'badges/448267-droolingcatking.png');
  hasnt('a frame that is not a slug is not let into an address', owned, 'img/site/frames/');
  hasnt('and a status Discord does not have draws no dot', owned, 'acct-status');
  ui.state.account = { ...ui.state.account, profile: { url: 'https://steamar.cc/@k', background: { preset: 'dusk' }, badges: [
    { id: 'donor', name: 'Donor', image_url: 'http://127.0.0.1:8788/img/site/badges/95458-heart.gif' },
    { id: 'bdg_1', name: 'Gold <star>', image_url: 'http://127.0.0.1:8788/img/site/badge/cccccccccccccccccccccccc.png' },
    { id: 'bdg_2', name: 'Elsewhere', image_url: 'https://evil.test/x.png' },
  ] } };
  ui.open_account();
  const marked = report('the account window', 'dialog');
  has('every badge the page shows, the role first', marked, 'data-tip="Donor"');
  has('and one the console gave, by its name', marked, 'data-tip="Gold &lt;star&gt;"');
  has('drawn through the engine', marked, 'src="http://127.0.0.1:8788/img/site/badge/cccccccccccccccccccccccc.png"');
  hasnt('never from an address it was not handed in that shape', marked, 'evil.test');
  ui.state.account = { ...ui.state.account, tier: 'none' };
  ui.open_account();
  const outside = report('the account window', 'dialog');
  hasnt('someone outside the server has no public page to open', outside, 'data-act="profile-view"');
  hasnt('or to copy', outside, 'data-act="profile-copy"');
  has('and is told where they stand', outside, 'Not in the server');
  ui.state.account = was_account;

  console.log('\nthe drawer');
  const target = games.find((g) => g.keyless) || games[0];
  if (target) {
    // A panel is drawn once per signature; a node left over from a previous run would look painted
    // when it is not.
    node('.dbody').innerHTML = '';
    node('.dbody').dataset = {};
    await ui.open_drawer(target.appid, {});
    await settle();
    const panel_body = report_html('the drawer', node('.dbody').innerHTML);
    has('it names the title it opened', panel_body, target.name ? String(target.name).slice(0, 10) : target.appid);
    has('and says whether it is already in the library', panel_body, 'In your library.');
    has('with a way to take it out', panel_body, 'data-remove=');
    ui.close_drawer();
    check('closing it puts the panel away', node('drawer').hidden, true);
  }

  // A free game Steam took off its store cannot be got there: the window offers the add instead.
  node('.dbody').innerHTML = '';
  node('.dbody').dataset = {};
  ui.state.verdicts['999001'] = null;
  ui.state.details['999001'] = { appid: '999001', name: 'Gone Free', free: true, removed: true, type: 'game', description: '', genres: [], players: [], developers: [], release: null };
  await ui.open_drawer('999001', { name: 'Gone Free' });
  const gone = report_html('a free game removed from Steam', node('.dbody').innerHTML);
  hasnt('is not sent to Steam', gone, 'Get it on Steam');
  has('says it was removed', gone, 'Removed from the Steam store');
  has('and can be added', gone, 'data-add="999001"');
  ui.close_drawer();

  console.log('\nthe tags a card carries');

  // The two facts the card could never show before, on rows built here rather than read from this
  // machine: the library record is only interesting for the states this PC happens to be in.
  const keyless_card = ui.card_html({ appid: '1', name: 'a keyless title', installed: false, keyless: true, valid: true }, 0);
  const installed_card = ui.card_html({ appid: '2', name: 'an installed title', installed: true, keyless: false, valid: true }, 0);
  const both_card = ui.card_html({ appid: '3', name: 'installed without a key', installed: true, keyless: true, valid: true }, 0);
  has('a keyless script says so', keyless_card, "Can't download yet</span>");
  hasnt('and is not called installed', keyless_card, 'Installed</span>');
  has('an installed title says so', installed_card, 'Installed</span>');
  hasnt('and is not called keyless', installed_card, "Can't download");
  has('an installed title with no key keeps only the true tag', both_card, 'Installed</span>');
  hasnt('and drops the warning about a download that already happened', both_card, "Can't download");

  console.log('\nthe setup steps');

  // Findings built here, like the cards above: what the steps say depends on what the checkup found,
  // and this PC only has the findings it happens to have.
  const was_setup = ui.state.setup;
  const was_repair = ui.state.repair;
  const finding = (id) => ({ id, severity: 'fix', fixable: true, action: 'fix', title: id, detail: id });
  ui.state.setup = { ...was_setup, ready: false };
  ui.state.repair = {
    steam_running: false,
    findings: ['dll-missing:dwmapi.dll', 'toml-missing', 'folder:depotcache'].map(finding),
    summary: { state: 'repair', fixable: 3, blockers: 0, warnings: 0 },
  };
  ui.render_setup();
  const fresh = report_html('a new PC', node('setup').innerHTML);
  has('a new PC is walked through the setup', fresh, 'get SteaMar working');
  hasnt('and is not told an older setup left something behind', fresh, 'data-act="repair-now"');
  ui.state.repair.findings.push(finding('dll-stale:xinput1_4.dll'));
  ui.render_setup();
  has('a file another tool left behind does ask for a repair first', node('setup').innerHTML, 'data-act="repair-now"');
  ui.state.setup = was_setup;
  ui.state.repair = was_repair;

  console.log('\nthe fixtures');
  if (missing.size) {
    total += 1;
    problems += 1;
    console.log(`  FAIL  ${missing.size} route(s) the page asks for are not in the fixture set:`);
    for (const route of missing) console.log(`          ${route}`);
    console.log('        run `node tools/check-views.js --record` against a running engine');
  } else {
    check('every route the page asked for was answered from a fixture', true, true);
  }

  if (record) {
    fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
    const ordered = Object.fromEntries([...known.entries()].sort(([a], [b]) => a.localeCompare(b)));
    fs.writeFileSync(FIXTURE, `${JSON.stringify(ordered, null, 2)}\n`, 'utf8');
    console.log(`\nwrote ${Object.keys(ordered).length} answers to test/fixtures/views/payloads.json`);
  }

  console.log(`\n${total - problems}/${total} checks ok${problems ? `, ${problems} failed` : ''}`);
  process.exit(problems ? 1 : 0);
})().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
