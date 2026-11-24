'use strict';

// Checks the door and the profile chip against a stub DOM, for every account answer the engine gives.
// It needs no window and no engine.
// Trap: it covers the signed-out states, which a developer's own signed-in copy never shows.

// The window's two social surfaces, checked without a window: the door that decides whether the app
// opens at all, and the mini profile in the corner that says who is reading it.
//
// Neither can be seen in a screenshot on a machine that is signed out, and the one that matters most
// - "does a fresh install really reach a sign-in screen" - is exactly the state nobody tests, because
// their own copy is always signed in. So the page is loaded against a stub DOM and asked, for every
// answer the engine can give, which screen it draws and whether the corner carries a person.
//
//   node tools/check-ui.js

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

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

/* ---------- the page, held still ---------- */

// One DOM, shared with tools/check-views.js: a stub that remembers what was written into each
// element and nothing else, which is all a renderer needs in order to be read.
const { node, document, window_stub, noop_timer, page_source, page_css } = require('./dom');

const window = window_stub();

const timer = noop_timer;
const source = page_source(path.join(ROOT, 'ui'));

// The file ends by booting; here it is quiet, because every case below sets the answer by hand.
const ui = new Function(
  'window', 'document', 'fetch', 'navigator', 'sessionStorage', 'localStorage', 'setTimeout',
  'setInterval', 'clearTimeout', 'clearInterval',
  `${source}\n; return { state, gate_reason, render_gate, render_profile };`,
)(window, document, () => new Promise(() => {}), {}, { getItem: () => null, setItem() {} }, { getItem: () => null },
  timer, timer, timer, timer);

const { state, gate_reason, render_gate, render_profile } = ui;
const gate = node('gate');
const main = node('main');
const profile = node('profile');

// One clean window per case: a stale panel from the last answer would pass for the next one.
const screen = (account, extra = {}) => {
  gate.innerHTML = '';
  gate.hidden = true;
  profile.innerHTML = '';
  profile.hidden = true;
  profile.title = '';
  profile.classList.set.clear();
  main.inert = false;
  state.account = account;
  state.account_error = extra.error || '';
  state.configured = extra.configured !== false;
  state.base = extra.base || '';
  state.campaign = (account && account.campaign) || null;
  render_gate();
  return {
    reason: gate_reason(),
    gate: gate.innerHTML,
    open: gate.hidden,
    inert: main.inert,
    profile: profile.innerHTML,
    corner: !profile.hidden,
    title: profile.title,
    quiet: profile.classList.contains('is-quiet'),
  };
};

/* ---------- the answers the engine can give ---------- */

const user = {
  username: 'n0tmar',
  global_name: 'Not Mar',
  avatar_url: 'https://cdn.discordapp.com/avatars/100000000000000001/abc.png',
};
const month = {
  percent: 41, target_usd: 10000, collected_usd: 4100, days_left: 9,
  note: 'We are 59 USD short of this month\'s running costs, with 9 days left.',
  manual_note: 'eleven days of hosting left',
};

console.log('\nthe door');

const fresh = screen({ known: true, linked: false, tier: 'none', gate: true, source: 'live' });
check('a fresh install is asked to sign in', fresh.reason, 'link');
check('and the app stays shut behind it', fresh.open, false);
check('a shut app cannot be tabbed into', fresh.inert, true);
has('the screen says what it is for', fresh.gate, 'Sign in to use SteaMar');
has('with the one button that works', fresh.gate, 'data-act="login"');
has('and the road ahead drawn', fresh.gate, 'class="gate-steps"');
hasnt('no profile before there is a person', fresh.gate + fresh.profile, 'pf-av');
check('and the corner is empty', fresh.corner, false);

const asking = screen({ known: false, source: 'asking' });
check('while the service is being asked', asking.reason, 'checking');
has('the screen says so instead of guessing', asking.gate, 'Connecting');
check('and nothing is drawn behind it', asking.open, false);

const broken = screen({ known: false, source: 'none' }, { base: 'http://127.0.0.1:8791' });
check('an engine that cannot answer', broken.reason, 'offline');
has('says it cannot connect', broken.gate, "Can't connect right now");
hasnt('and prints no address a person cannot use', broken.gate, '127.0.0.1:8791');
check('the app is shut', broken.inert, true);

const dev = screen({ known: false, source: 'none' }, { configured: false });
check('a build with no key has no door to demand', dev.reason, null);
check('so it opens', dev.open, true);

console.log('\nthe doors behind it');

const joined = screen({ known: true, linked: true, tier: 'member', gate: true, user, source: 'live' });
check('a member walks in', joined.reason, null);
check('the gate is gone', joined.open, true);
check('the app is live again', joined.inert, false);
check('and the corner has them', joined.corner, true);
has('by name', joined.profile, 'Not Mar');
has('with the handle and the role', joined.profile, '@n0tmar');
has('a donor or a member is stated, never invented', joined.profile, 'Member');
has('the avatar is the real one', joined.profile, 'cdn.discordapp.com');
has('the corner opens the site account', joined.profile, 'pf-go');
hasnt('nothing is claimed about a quiet service', joined.title, 'last checked');

const outsider = screen({ known: true, linked: true, tier: 'none', gate: true, user, source: 'live' });
check('signed in but not in the server', outsider.reason, 'join');
has('is told exactly that', outsider.gate, 'Join our Discord to continue');
has('and the second step is the one lit', outsider.gate, '<li class="on">Join the server</li>');
has('with their own face so it is not a stranger talking', outsider.gate, 'Not Mar');

const paused = screen({ known: true, linked: true, tier: 'member', gate: true, user, paused: { active: true }, pass: { active: false }, campaign: month, source: 'live' });
check('a paused month', paused.reason, 'paused');
has('shows the gap', paused.gate, '$41');
has('and the note the operator wrote', paused.gate, 'eleven days of hosting left');
hasnt('but not the sentence that repeats the meter', paused.gate, 'USD short');

const lever = screen({ known: true, linked: true, tier: 'member', gate: true, user, paused: { active: true }, pass: { active: false }, campaign: { reason: 'manual', manual_note: 'Back in an hour - moving the download host.' }, source: 'live' });
check('a pause the owner pulled by hand', lever.reason, 'paused');
has('says it is paused right now', lever.gate, 'SteaMar is paused right now');
has('in the owner\'s words', lever.gate, 'Back in an hour - moving the download host.');
hasnt('and asks for no money', lever.gate, 'data-act="donate"');

const donor = screen({ known: true, linked: true, tier: 'donor', gate: true, user, paused: { active: true }, pass: { active: true }, campaign: month, source: 'live' });
check('a donor in a paused month keeps the app', donor.reason, null);
check('and still has a corner', donor.corner, true);

console.log('\nthe quiet service');

// The case this pass exists for: signed in before, service down now. The app opens on the answer it
// saved, and the corner says how old that answer is rather than pretending it is current.
const offline = screen(
  { known: true, linked: true, tier: 'member', gate: true, user, source: 'saved', checked_at: new Date(Date.now() - 3 * 3600 * 1000).toISOString() },
);
check('a saved identity still opens the app', offline.reason, null);
check('with the person in the corner', offline.corner, true);
has('and the age of the answer on hover', offline.title, 'last checked');
check('marked as the older answer it is', offline.quiet, true);

// Every start draws the saved answer first while today's is asked for. That second is not an outage,
// and the corner must not flash the offline colour through it.
const starting = screen(
  { known: true, linked: true, tier: 'member', gate: true, user, source: 'saved', asking: true, checked_at: new Date(Date.now() - 3 * 3600 * 1000).toISOString() },
);
check('a start opens on the saved answer', starting.reason, null);
check('without the offline colour while it asks', starting.quiet, false);
hasnt('or an offline title', starting.title, 'offline');

const lapsed = screen({ known: true, linked: false, tier: 'none', gate: true, source: 'saved' });
check('a saved "not signed in" is still a door', lapsed.reason, 'link');

/* ---------- every class the new markup emits has a rule ---------- */

console.log('\nthe stylesheet knows the words');

const css = page_css(path.join(ROOT, 'ui'));
const emitted = [
  'rail-foot', 'profile', 'pf-av', 'pf-id', 'pf-go', 'is-quiet',
  'gate-steps', 'gate-foot',
];
for (const name of emitted) {
  check(`.${name} is styled`, new RegExp(`\\.${name}(?![\\w-])`).test(css), true);
}

// The markup is what the functions read: the corner button sits under Donate, the rail's one ask.
const html = read('ui/index.html');
const order = ['rail-link donate', 'class="profile" id="profile"'].map((needle) => html.indexOf(needle));
check('the corner button exists', order[1] > 0, true);
check('under Donate', order[0] > 0 && order[0] < order[1], true);
hasnt('and the rail has no Discord link of its own', html, 'rail-link" href="https://discord.gg');
has('and it is filled by the renderer, not hard-coded', html, 'data-act="account-open"');

console.log(`\n${total - problems}/${total} checks ok${problems ? `, ${problems} failed` : ''}`);
process.exit(problems ? 1 : 0);
