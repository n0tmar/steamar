'use strict';

// The door: who is signed in on this PC, decided before anything else is drawn. The gate screens
// (asking, missing, the door, inside), the profile chip, the sign-in that waits for the browser,
// and the status bar drawn once the person is in. The engine side is app/src/account.js.
// Trap: boot waits on `load_account()`. A view that draws before `after_gate()` shows a
// signed-out person the library.

/* ---------- who is using this PC ---------- */

// The account and the month, in one call from the engine. It is the first thing boot asks, because
// the answer decides whether the rest of the app should be drawn at all.
async function load_account({ force = false } = {}) {
  try {
    const answer = await api(force ? '/api/account?force=1' : '/api/account');
    const picks_before = JSON.stringify((state.account && state.account.home) || null);
    state.account = answer.account || null;
    // The owner changed the games at the top of Home: the shelves are asked again, with their art.
    if (state.store && JSON.stringify((state.account && state.account.home) || null) !== picks_before) {
      load_store(true).catch(() => {});
    }
    state.campaign = (answer.account && answer.account.campaign) || answer.campaign || null;
    state.base = answer.base || '';
    state.configured = answer.configured !== false;
    state.account_error = '';
  } catch (err) {
    // The engine itself did not answer. There is nothing to sign in against and nothing to draw:
    // the gate says so and keeps its retry. The account is left as it was, so a poll that fails
    // during a restart does not erase who was here.
    state.account_error = err.message || '';
  }
  render_profile();
  return state.account;
}

// The one question the whole first screen hangs on. `null` means "no gate". Two answers are not a
// gate: a build with no pinned key (there is no door to open, so there is nothing to demand), and a
// machine whose saved identity is still fresh while the service is quiet - it keeps the app it
// already had. Everything else is a screen, including the first run of a fresh install.
function gate_reason() {
  const a = state.account;
  if (state.account_error) return 'offline';
  if (!a) return state.configured === false ? null : 'checking';
  if (!a.known) {
    if (state.configured === false) return null;
    return a.source === 'asking' ? 'checking' : 'offline';
  }
  if (!a.linked) return a.gate ? 'link' : null;
  if (a.kill && a.kill.active) return 'killed';
  if (a.tier === 'none') return 'join';
  if (a.paused && !(a.pass && a.pass.active)) return 'paused';
  return null;
}

let login_timer = null;
let account_timer = null;

const usd = (cents) => {
  const value = Number(cents || 0) / 100;
  return `$${Number.isInteger(value) ? value.toFixed(0) : value.toFixed(2)}`;
};

// One timer for the whole window, at four speeds: a fast look while the service is being asked, a
// slower one while it is out of reach, half a minute while a door is shut (a role or a donation
// lands on its own), and one quiet call every ten minutes once somebody is inside.
const GATE_ASKING = 900;
const GATE_MISSING = 5000;
const GATE_DOOR = 30000;
const GATE_INSIDE = 10 * 60 * 1000;

function gate_speed(reason) {
  if (reason === 'checking') return GATE_ASKING;
  if (reason === 'offline') return GATE_MISSING;
  if (reason) return GATE_DOOR;
  return GATE_INSIDE;
}

function watch_account(delay) {
  clearInterval(account_timer);
  account_timer = null;
  if (!delay) return;
  // Inside, the ticks are ten minutes apart, so each one waits for a fresh answer instead of taking
  // the one the engine had from before. At the door they are seconds apart and need not wait.
  account_timer = setInterval(() => recheck_account(delay === GATE_INSIDE), delay);
}

async function recheck_account(force = false) {
  await load_account({ force });
  if (gate_reason()) return render_gate();
  // The door opened by itself. Finish the boot it interrupted, or - if the app was already open -
  // pick up what changed while the door was shut.
  render_gate();
  if (!state.ready) await after_gate();
  else await refresh_all();
}

// Coming back to the window is when something may have changed somewhere else: a donation, a new
// role, a sign-in finished in the browser. Ask then, at most once a minute, instead of waiting for
// the timer. Inside, only what shows the account is redrawn, so nothing jumps under the reader.
// The clock starts at load: the window taking focus as it opens is not a return.
let returned_at = Date.now();

async function on_return() {
  if (document.hidden || !state.account || Date.now() - returned_at < 60000) return;
  returned_at = Date.now();
  const was = gate_reason();
  await load_account({ force: true });
  if (was || gate_reason()) {
    if (gate_reason()) return render_gate();
    render_gate();
    if (!state.ready) await after_gate();
    else await refresh_all();
    return;
  }
  render_status();
  if (shown_tab === 'settings') render_settings();
  else if (shown_tab === 'fixes') render_fixes();
}

// The short road, drawn: three steps with the one you are on lit. A person who can see the end of a
// three-step road walks it; a person facing an unlabelled wall knocks twice and closes the window.
function gate_steps(active) {
  const steps = ['Sign in', 'Join the server', 'Open the app'];
  return `<ol class="gate-steps">${steps.map((label, i) => {
    const n = i + 1;
    return `<li class="${n === active ? 'on' : n < active ? 'done' : ''}">${esc(label)}</li>`;
  }).join('')}</ol>`;
}

function render_gate() {
  const panel = $('gate');
  const reason = gate_reason();
  if (!reason) {
    panel.hidden = true;
    panel.innerHTML = '';
    if ($('main')) $('main').inert = false;
    render_profile();
    watch_account(GATE_INSIDE);
    return;
  }

  const a = state.account || {};
  const c = (a.campaign || state.campaign || {});
  const user = a.user || null;
  const who = user ? `
    <div class="who">
      ${user.avatar_url ? `<img src="${esc(user.avatar_url)}" alt="">` : ''}
      <div><b>${esc(user.global_name || user.username || 'you')}</b><em>@${esc(user.username || '')}</em></div>
    </div>` : '';

  let body = '';
  if (reason === 'checking') {
    body = `
      <h1>Connecting</h1>
      <p>This takes a moment the first time. After that, SteaMar remembers you on this PC.</p>
      <div class="gate-actions">
        <button class="btn ghost" data-act="account-retry">Try again</button>
      </div>`;
  } else if (reason === 'offline') {
    body = `
      <h1>Can't connect right now</h1>
      <p>SteaMar needs the internet to sign you in. Check your connection. Nothing on this PC is
         broken or lost, and this window carries on by itself as soon as it connects.</p>
      <div class="gate-actions">
        <button class="btn primary" data-act="account-retry">Try again</button>
        <a class="btn ghost" href="${COMMUNITY}" target="_blank" rel="noreferrer noopener">Ask on Discord</a>
      </div>`;
  } else if (reason === 'link') {
    body = `
      ${gate_steps(1)}
      <h1>Sign in to use SteaMar</h1>
      <p>SteaMar shares a library with members of our Discord. Signing in tells this app your name,
         your picture and the role you hold in the server. Nothing else, and no password.</p>
      <div class="gate-actions">
        <button class="btn primary" data-act="login">Sign in with Discord</button>
        <a class="btn ghost" href="${COMMUNITY}" target="_blank" rel="noreferrer noopener">Open Discord</a>
      </div>
      <p class="gate-foot">Your browser opens for the sign-in and comes straight back here. One
         sign-in per PC, and it is remembered.</p>
      <div data-login-slot></div>`;
  } else if (reason === 'join') {
    body = `
      ${who}
      ${gate_steps(2)}
      <h1>Join our Discord to continue</h1>
      <p>SteaMar is for members of our Discord server. Join it, then press Check again. It can take a
         few seconds for your membership to show up.</p>
      <div class="gate-actions">
        <a class="btn primary" href="${COMMUNITY}" target="_blank" rel="noreferrer noopener">Join the server</a>
        <button class="btn ghost" data-act="gate-check">Check again</button>
      </div>`;
  } else if (reason === 'killed') {
    // Not a month that went short: a person cannot donate their way past this one, so the screen
    // offers no meter and no button that asks for money. It says what was said, that nothing here is
    // broken, and how to check again.
    const k = a.kill || {};
    body = `
      <h1>SteaMar is off right now</h1>
      <p>${k.reason ? esc(k.reason) : 'It is paused for everyone for now.'}</p>
      <p class="quiet">Nothing on this PC is broken - your library, your account and your settings are
         where you left them. When it is back, this window opens on them again.</p>
      <div class="gate-actions">
        <button class="btn primary" data-act="gate-check">Check again</button>
        <a class="btn ghost" href="${COMMUNITY}" target="_blank" rel="noreferrer noopener">Ask on Discord</a>
      </div>
      <p class="gate-foot">The SteaMar team turned it off. It is not a problem with your account.</p>`;
  } else if (c.reason === 'manual') {
    // The owner paused it by hand (moving a download host, say). That is not a money problem, so the
    // screen shows no meter and asks for nothing.
    body = `
      <h1>SteaMar is paused right now</h1>
      <p>${c.manual_note ? esc(c.manual_note) : 'The SteaMar team paused it for a short while.'}</p>
      <p class="quiet">Nothing on this PC is broken. This window opens again as soon as it is back.</p>
      <div class="gate-actions">
        <button class="btn primary" data-act="gate-check">Check again</button>
        <a class="btn ghost" href="${COMMUNITY}" target="_blank" rel="noreferrer noopener">Ask on Discord</a>
      </div>`;
  } else {
    const percent = Math.max(0, Math.min(100, Number(c.percent) || 0));
    const days = Number(c.days_left);
    body = `
      <h1>SteaMar is paused this month</h1>
      <p>This month's donations have not covered the running costs yet, so the app is off until they
         do. Sorry about that. We would rather ask than charge you.</p>
      <div class="gate-meter">
        <div class="bar"><i style="width:${percent}%"></i></div>
        <div class="nums">
          <b>${esc(usd(c.collected_usd))}</b>
          <span>of ${esc(usd(c.target_usd))}${Number.isFinite(days) ? ` \u00b7 ${days} day${days === 1 ? '' : 's'} left` : ''}</span>
        </div>
      </div>
      ${c.manual_note ? `<p class="quiet">${esc(c.manual_note)}</p>` : ''}
      <p class="quiet">Already donated? Thank you - nothing else to do.</p>
      <div class="gate-actions">
        <button class="btn primary" data-act="donate">Donate</button>
        <button class="btn ghost" data-act="gate-check">Check again</button>
      </div>`;
  }

  panel.innerHTML = `<div class="gate-inner"><div class="gate-mark"><img src="/logo.png" alt=""></div>${body}</div>`;
  panel.hidden = false;
  if ($('main')) $('main').inert = true;
  render_profile();
  watch_account(gate_speed(reason));
}

// Discord's status dot, in the shapes the page draws: full for online, a moon for idle, a bar for do
// not disturb, a ring for invisible. The cut-outs are painted in the colour of what the dot sits on
// (account.css), so they need no masks. The person sees their own invisible, as Discord shows it.
const STATUS_NAMES = { online: 'Online', idle: 'Idle', dnd: 'Do Not Disturb', invisible: 'Invisible', offline: 'Offline' };
const STATUS_CUTS = {
  idle: '<circle class="cut" cx="2.5" cy="2.5" r="3.75"/>',
  dnd: '<rect class="cut" x="1.25" y="3.75" width="7.5" height="2.5" rx="1.25"/>',
  invisible: '<circle class="cut" cx="5" cy="5" r="2.5"/>',
  offline: '<circle class="cut" cx="5" cy="5" r="2.5"/>',
};
function status_dot(status, cls) {
  const kind = status && STATUS_NAMES[status.kind] ? status.kind : null;
  if (!kind) return '';
  return `<span class="${cls} is-${kind}" role="img" title="${STATUS_NAMES[kind]}" aria-label="${STATUS_NAMES[kind]}"><svg viewBox="0 0 10 10" aria-hidden="true"><circle cx="5" cy="5" r="5"/>${STATUS_CUTS[kind] || ''}</svg></span>`;
}

// The corner: who is signed in, what they are, and the one door out to the site where the rest of
// the picture lives. Hidden until there is a person, because a profile with nobody in it is worse
// than an empty corner.
function render_profile() {
  const el = $('profile');
  if (!el) return;
  const a = state.account;
  const u = a && a.known && a.linked ? a.user : null;
  if (!u) {
    el.hidden = true;
    el.innerHTML = '';
    el.removeAttribute('title');
    return;
  }

  const name = u.global_name || u.username || 'signed in';
  const tier = a.tier === 'donor' ? 'Donor' : a.tier === 'member' ? 'Member' : 'No role';
  // The saved copy is what every start draws first; it is offline only once nothing is being asked.
  const saved = a.source === 'saved' && !a.asking;
  const initial = name.slice(0, 1).toUpperCase();
  const avatar = u.avatar_url
    ? `<img src="${esc(u.avatar_url)}" alt="" width="26" height="26" decoding="async" data-initial="${esc(initial)}" onerror="this.parentNode.textContent=this.dataset.initial;this.remove()">`
    : esc(initial);

  // The name of their page (a bought name, or the owner's 1), and their status on the picture, as
  // Discord's own corner carries it.
  const page = a.profile || null;
  el.innerHTML = `
    <span class="pf-me"><span class="pf-av">${avatar}</span>${status_dot(page && page.status, 'pf-dot')}</span>
    <span class="pf-id">
      <b>${esc(name)}</b>
      <span>@${esc((page && page.handle) || u.username || 'unknown')} \u00b7 ${esc(tier)}</span>
    </span>
    ${icon('right', 'pf-go')}`;
  // A saved answer is the truth as of the last time the service was reachable. Saying so costs one
  // attribute and stops the corner from claiming to be current when the status bar says otherwise.
  el.title = saved
    ? `Your account \u00b7 offline, last checked ${esc(ago(a.checked_at))}`
    : 'Your account';
  el.classList.toggle('is-quiet', saved);
  el.hidden = false;
}

// The account, inside the app: the person's card as their page draws it (banner, picture and frame,
// status, name and mark, pronouns, About me, links, how long they have been here), the link to that
// page, and the three things a person does with an account here (donate, sign out, close). It is the
// app's own dialog, not a page on the site, and it leaves out the games: the app has those already.
// An address the engine handed over, let in only in the one shape it should have.
const art = (url, shape) => (typeof url === 'string' && shape.test(url) && !/['"\s]/.test(url) ? url : null);

function open_account() {
  const a = state.account;
  const u = a && a.linked ? a.user : null;
  if (!u) return;
  if (dialog_answer) close_dialog(false);
  const panel = $('dialog');
  dialog_return_focus = document.activeElement;

  const name = u.global_name || u.username || 'Signed in';
  const initial = name.slice(0, 1).toUpperCase();
  const avatar = u.avatar_url
    ? `<img src="${esc(u.avatar_url)}" alt="" width="76" height="76" decoding="async" data-initial="${esc(initial)}" onerror="this.parentNode.textContent=this.dataset.initial;this.remove()">`
    : esc(initial);
  // The frame and the badges are the page's own files on the site. The engine hands over their
  // addresses (page.frame_url, page.marks): inside the window only it can reach them.
  const inside = a.tier === 'donor' || a.tier === 'member';
  const page = inside ? a.profile || null : null;

  // The role, the way the page draws it: the mark alone at the end of the name, its word on hover.
  // Someone outside the server has no mark, and is told so in words.
  const [kind, tip] = page && page.owner ? ['owner', 'Runs SteaMar']
    : a.tier === 'donor' ? ['donor', 'Donor - keeps SteaMar online'] : ['member', 'Member'];
  const file = page && page.marks && kind !== 'member' ? art(page.marks[kind], /\/img\/site\/badges\/[\w.-]+\.(?:png|gif)$/) : null;
  const role = !inside ? '<span class="acct-role is-out">Not in the server</span>'
    : `<span class="acct-tag is-${kind}" role="img" data-tip="${tip}" aria-label="${tip}">${file
      ? `<img src="${esc(file)}" alt="" width="20" height="20" onerror="this.onerror=null;this.src='/logo.png'">`
      : '<img src="/logo.png" alt="" width="16" height="16">'}</span>`;

  // The banner picture; without one the page's background shows through, as it does on the page.
  const bg = (page && (page.banner || page.background)) || {};
  const banner = bg.image_url
    ? `class="acct-banner is-image" style="background-image:url('${esc(bg.image_url.replace(/['"\\()]/g, ''))}')"`
    : `class="acct-banner bg-${esc(/^[a-z]+$/.test(bg.preset || '') ? bg.preset : 'night')}"`;
  // Over the picture, the same GIF the page uses.
  const frame = page ? art(page.frame_url, /\/img\/site\/frames\/[a-z0-9-]+\.gif$/) : null;
  const status = page ? page.status : null;
  const said = status && status.text ? String(status.text) : '';
  const pronouns = page && page.pronouns ? String(page.pronouns) : '';
  const links = page && Array.isArray(page.links) ? page.links : [];
  const shown = page && page.url ? page.url.replace(/^https?:\/\//, '') : '';

  const month = (iso) => {
    const at = iso ? new Date(iso) : null;
    return at && !Number.isNaN(at.getTime()) ? at.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }) : '';
  };
  const count = (u.donations && u.donations.count) || 0;
  const facts = [
    inside && month(u.joined_server) ? ['<img src="/logo.png" alt="" width="15" height="15">', `Member since ${month(u.joined_server)}`] : null,
    a.tier === 'donor' && month(u.donor_since)
      ? [icon('heart', 'fill'), `Donor since ${month(u.donor_since)}${count ? ` · ${count} donation${count === 1 ? '' : 's'}` : ''}`] : null,
    a.paused ? [icon('warn'), a.pass && a.pass.active
      ? 'SteaMar is paused, but your donation this month keeps it on for you.'
      : 'SteaMar is paused until this month is covered.'] : null,
  ].filter(Boolean);

  panel.innerHTML = `
    <div class="dialog-panel acct" role="dialog" aria-modal="true" aria-labelledby="dialog-title">
      <div ${banner}>
        <button class="acct-x" data-answer="1" aria-label="Close">${icon('close')}</button>
      </div>
      <div class="acct-top">
        <span class="acct-me">
          <span class="acct-av">${avatar}</span>
          ${frame ? `<img class="acct-frame" src="${esc(frame)}" alt="" aria-hidden="true" onerror="this.remove()">` : ''}
          ${status_dot(status, 'acct-status')}
        </span>
        ${said ? `<p class="acct-bubble"><span>${esc(said)}</span></p>` : ''}
      </div>
      <h2 id="dialog-title" class="acct-name"><span>${esc(name)}</span>${role}</h2>
      <p class="acct-user"><span>@${esc((page && page.handle) || u.username || '')}</span>${pronouns
        ? `<span class="acct-sep" aria-hidden="true"></span><span class="acct-pronouns">${esc(pronouns)}</span>` : ''}</p>
      ${page && page.bio ? `<section class="acct-sec"><h3>About me</h3><p class="acct-bio">${esc(page.bio)}</p></section>` : ''}
      ${links.length ? `<div class="acct-links">${links.map((link, index) => `<button class="acct-linkto" data-act="profile-link" data-link="${index}" title="${esc(social_name(link.kind))}" aria-label="${esc(social_name(link.kind))}">${social_icon(link.kind)}</button>`).join('')}</div>` : ''}
      ${facts.length ? `<section class="acct-sec"><h3>On SteaMar</h3><ul class="acct-facts">${facts.map(([mark, text]) => `<li>${mark}<span>${esc(text)}</span></li>`).join('')}</ul></section>` : ''}
      ${shown ? `
      <div class="acct-link">
        ${icon('link')}<span title="${esc(page.url)}">${esc(shown)}</span>
        <button class="acct-copy" data-act="profile-copy" aria-label="Copy the link to your page">${icon('copy')}<b>Copy</b></button>
      </div>
      <div class="acct-go">
        <button class="btn" data-act="profile-edit">${icon('pencil')}Edit profile</button>
        <button class="btn" data-act="profile-view">${icon('external')}View page</button>
      </div>` : ''}
      <div class="acct-foot">
        <button class="btn ghost" data-act="logout">${icon('out')}Sign out</button>
        <button class="btn primary" data-act="donate">${icon('heart', 'fill')}Donate</button>
      </div>
    </div>`;
  panel.hidden = false;
  for (const node of [$('main'), $('setup'), $('drawer')]) if (node) node.inert = true;
  (panel.querySelector('.acct-copy') || panel.querySelector('[data-act="donate"]'))?.focus();
  return new Promise((resolve) => { dialog_answer = resolve; });
}

// Signing out asks first, because the next thing this PC shows is the sign-in screen.
async function sign_out() {
  const yes = await ask({
    title: 'Sign out of this PC?',
    message: 'SteaMar will ask you to sign in again. Your games stay in Steam.',
    ok: 'Sign out',
    danger: true,
  });
  if (!yes) return;
  try {
    await api('/api/logout', { method: 'POST' });
  } catch (err) {
    toast(err.message, true);
    return;
  }
  await load_account({ force: true });
  render_gate();
}

// Attaching this PC, without a Discord login in this window: the engine asks for a code, opens the
// real browser, and this page watches the code until the browser claims it.
async function start_login(button) {
  const slot = document.querySelector('[data-login-slot]');
  if (button) button.disabled = true;
  if (slot) slot.innerHTML = '<p class="quiet">Opening your browser\u2026</p>';
  try {
    const answer = await api('/api/login', { method: 'POST' });
    if (slot) {
      slot.innerHTML = `<div class="gate-code">Finish signing in in your browser \u00b7 code ${esc(answer.code)}</div>`;
    }
    poll_login(answer.code);
  } catch (err) {
    if (slot) slot.innerHTML = `<p class="notice bad">${esc(err.message)}</p>`;
    if (button) button.disabled = false;
  }
}

function poll_login(code) {
  clearInterval(login_timer);
  const started = Date.now();
  login_timer = setInterval(async () => {
    if (Date.now() - started > 5 * 60 * 1000) {
      clearInterval(login_timer);
      return;
    }
    let answer;
    try {
      answer = await api(`/api/login/status?code=${encodeURIComponent(code)}`);
    } catch {
      return; // the code is still good; a failed poll is not a failed login
    }
    if (answer.status !== 'done') return;
    clearInterval(login_timer);
    await load_account();
    if (gate_reason()) return render_gate();
    render_gate();
    await after_gate();
  }, 2000);
}

// At start the corner and the door are drawn from the answer saved last time, so the window opens at
// once. Today's answer is asked for straight away, so a changed role or month shows within a second
// instead of at the ten-minute tick.
async function confirm_account() {
  await load_account({ force: true });
  if (gate_reason()) return render_gate();
  render_status();
}

// Everything boot does once the person is through the gate. Called from boot, from a sign-in that
// just landed, and from the watch that finds the door open - so it runs once per window and no more:
// a door reopening is not a second boot. `ready` is set at the end, not the start, so a boot that
// fails halfway is still retried by the next tick instead of leaving half a window with no way back.
let booting = null;

async function after_gate() {
  if (state.ready) return;
  if (booting) return booting;

  booting = (async () => {
    // Home's shelves come from Steam and take longest, so they are asked first; a store that fails
    // says so on Home, where it is missed, and a toast on any other tab would be noise.
    load_store().catch(() => {});
    await Promise.all([load_library(), load_status(), load_setup(), load_reach()]);
    await route();
    render_profile();
    // The repair check hashes the helper files and holds the engine while it does, so it is asked
    // after the first paint, with the settings facts: nothing on the opening view needs either.
    await Promise.all([
      load_repair(),
      (state.settings ? Promise.resolve(state.settings) : api('/api/settings'))
        .then((s) => { state.settings = s; render_status(); }).catch(() => {}),
    ]);
    if (shown_tab === 'settings') render_settings();

    // New machine, or the files were removed: walk them through it once per session. This lives here
    // rather than in boot so that signing in on a fresh PC opens the same steps instead of skipping
    // them - the setup wizard is behind the door, and the door is new.
    const needs_repair = Boolean(state.repair && state.repair.findings.some((f) => f.fixable));
    const open_steps = Boolean(state.setup) && (!state.setup.ready || (needs_repair && !state.setup.steam_running));
    if (open_steps && !sessionStorage.getItem('setup-dismissed')) open_setup();

    state.ready = true;
  })();

  try {
    return await booting;
  } finally {
    booting = null;
  }
}

function render_status() {
  const s = state.status;
  if (!s) return;

  // Four facts at most, and a warning only when there is something to do about it. The count of games
  // waits for its answer instead of saying "counting", and an outage is one word.
  const offline = state.reach ? state.reach.mode === 'none' : Boolean(state.reach_error);
  const reach_seg = offline
    ? '<div class="seg"><span class="v warn" title="SteaMar can\'t connect. Check your internet connection.">Offline</span></div>'
    : state.reach
      ? `<div class="seg"><span class="v">${Number(state.reach.games_total || 0).toLocaleString()} games available</span></div>`
      : '';

  // A newer build is worth a corner of the screen, not only a row two clicks away in Settings.
  const update = state.settings && state.settings.app && state.settings.app.update;
  const update_warn = update && (update.state === 'optional' || update.state === 'required');
  const update_seg = update_warn
    ? `<div class="seg"><a class="v warn" href="#/settings" title="${esc(update.state === 'required' ? 'This version is too old' : `Version ${update.version || ''} is out`)}">${update.state === 'required' ? 'Update required' : 'Update available'}</a></div>`
    : '';

  // Busy is measured, not scheduled: when the service says it is under load, a member is told the
  // one thing that is true and useful - donors are not in this queue - instead of a mystery pause.
  const account = state.account;
  const busy = Boolean(account && account.peak && account.peak.active);
  const busy_seg = busy
    ? `<div class="seg"><span class="v warn" title="SteaMar is busy right now. ${account.tier === 'donor' ? 'As a donor, you skip the queue.' : 'Donors skip the queue.'}">${account.tier === 'donor' ? 'Busy' : 'Busy \u00b7 donors skip the queue'}</span></div>`
    : '';

  // A donor in a paused month is different from a member in one: they keep working, and the corner
  // says why, once, without a nag.
  const paused = Boolean(account && account.paused);
  const pass = Boolean(account && account.pass && account.pass.active);
  const paused_seg = paused
    ? `<div class="seg"><button class="v warn" data-act="gate-check" title="${pass ? 'SteaMar is paused for this month. You still have access because you donated.' : 'SteaMar is paused for this month. Press to check again.'}">${pass ? 'Paused \u00b7 you still have access' : 'Paused'}</button></div>`
    : '';

  $('statusbar').innerHTML = `
    <div class="seg"><span class="v ${s.steam_running ? 'on' : 'off'}">Steam ${s.steam_running ? 'running' : 'closed'}</span></div>
    ${reach_seg}
    ${busy_seg}
    ${paused_seg}
    ${update_seg}
    <div class="seg spacer"><span class="v">${s.scripts} in library</span></div>`;
}

function render_counts() {
  $('c-all').textContent = games().length;
}
