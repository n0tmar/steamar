'use strict';

// Drives the real desktop window over CDP on 127.0.0.1:9222 and checks what a screenshot cannot.
// It needs a built app and is not a unit test.
// Trap: whatever answers on port 9222 is treated as the window.

// Self-check for the desktop shell: drives the real window over CDP and proves the things that
// cannot be seen in a screenshot — selection and copy are blocked, fields stay usable, the native
// confirm dialog reaches the window with the right answer, and an uncaught error is reported.
//
//   npm run verify:app          (build first; needs the engine or lets the app start it)
//
// Exits non-zero if anything is off. Screenshots stay in out/; this belongs in tools/.

const http = require('node:http');
const { execFileSync, spawn } = require('node:child_process');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
const check = (name, actual, expected) => {
  const ok = String(actual) === String(expected);
  if (!ok) failed += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(18)} ${actual}${ok ? '' : `  (expected ${expected})`}`);
  return ok;
};

const get = (path) =>
  new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: 9222, path }, (res) => {
      let s = '';
      res.on('data', (d) => { s += d; });
      res.on('end', () => { try { resolve(JSON.parse(s)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });

(async () => {
  const app = spawn('native\\build\\Release\\SteaMar.exe', ['--devtools', '--size', '1280x800'], { detached: true, stdio: 'ignore' });
  app.unref();

  let target = null;
  for (let i = 0; i < 80 && !target; i += 1) {
    await wait(250);
    try {
      const list = await get('/json/list');
      target = list.find((t) => t.type === 'page' && t.url.includes('steamar.cc'));
    } catch { /* not up yet */ }
  }
  if (!target) throw new Error('no page target');

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    const done = pending.get(msg.id);
    if (!done) return;
    pending.delete(msg.id);
    msg.error ? done.reject(new Error(msg.error.message)) : done.resolve(msg.result);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const mine = ++id;
    pending.set(mine, { resolve, reject });
    ws.send(JSON.stringify({ id: mine, method, params }));
  });
  const evaluate = async (expression) => {
    const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.text);
    return res.result.value;
  };

  await send('Runtime.enable');
  for (let i = 0; i < 60; i += 1) {
    if (await evaluate('document.querySelectorAll(".card").length > 0')) break;
    if (await evaluate('Boolean(document.getElementById("gate") && !document.getElementById("gate").hidden)')) break;
    await wait(250);
  }

  // A machine that is signed out has no app to drive: the door is the whole window, and every
  // assertion below would fail on a page that is deliberately inert. Say that once, plainly, and
  // leave with a code of its own instead of twenty confusing failures.
  const door = await evaluate(`(() => {
    const g = document.getElementById('gate');
    if (!g || g.hidden) return '';
    const h = g.querySelector('h1');
    return h ? h.textContent : 'a screen with no heading';
  })()`);
  if (door) {
    console.log(`the door is up: "${door}"`);
    console.log('sign in from the app window, then run this again - there is no app behind a gate to drive.');
    process.exit(2);
  }

  check('body user-select', await evaluate('getComputedStyle(document.body).userSelect'), 'none');
  check('selectstart blocked', await evaluate(`(() => {
    const e = new MouseEvent('selectstart', { bubbles: true, cancelable: true });
    document.querySelector('.card .name').dispatchEvent(e);
    return e.defaultPrevented;
  })()`), true);
  check('copy blocked', await evaluate(`(() => {
    const e = new Event('copy', { bubbles: true, cancelable: true });
    document.querySelector('.card .name').dispatchEvent(e);
    return e.defaultPrevented;
  })()`), true);
  check('drag blocked', await evaluate(`(() => {
    const e = new Event('dragstart', { bubbles: true, cancelable: true });
    document.querySelector('.card').dispatchEvent(e);
    return e.defaultPrevented;
  })()`), true);
  check('context menu blocked', await evaluate(`(() => {
    const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    document.querySelector('.card').dispatchEvent(e);
    return e.defaultPrevented;
  })()`), true);
  check('rail mark is artwork', await evaluate(`(() => {
    const img = document.querySelector('.brand .mark img');
    return img ? img.complete && img.naturalWidth === 128 && Math.round(img.getBoundingClientRect().width) === 26 : 'no img';
  })()`), true);
  // one icon family: the rail glyphs come from the same map as every button's
  check('rail glyphs drawn', await evaluate(`document.querySelectorAll('.nav .ic svg').length`), 4);
  check('search field glyph drawn', await evaluate(`document.querySelectorAll('.field .ic svg').length`), 1);
  check('every rail glyph is a path family', await evaluate(`(() => {
    const shapes = [...document.querySelectorAll('.nav .ic svg *')].map((n) => n.tagName);
    return shapes.length > 0 && shapes.every((t) => t === 'path' || t === 'circle' || t === 'rect');
  })()`), true);
  check('input user-select', await evaluate('getComputedStyle(document.getElementById("q")).userSelect'), 'text');
  check('input caret', await evaluate('getComputedStyle(document.getElementById("q")).cursor'), 'text');

  // A panel left open from a click before the run would make the page behind inert, and every
  // keyboard check below would fail for a reason that has nothing to do with keyboards.
  check('the page starts with no panel', await evaluate(`(() => {
    close_drawer();
    return document.getElementById('drawer').hidden && !document.getElementById('main').inert;
  })()`), true);

  // editing keys must survive the accelerator lockout: Ctrl+A still selects the whole field
  await evaluate(`(() => { const q = document.getElementById('q'); q.focus(); q.value = 'elden ring'; q.setSelectionRange(0, 0); })()`);
  for (const type of ['rawKeyDown', 'keyUp']) {
    await send('Input.dispatchKeyEvent', { type, modifiers: 2, windowsVirtualKeyCode: 65, code: 'KeyA', key: 'a' });
  }
  await wait(200);
  const range = await evaluate(`(() => { const q = document.getElementById('q'); return q.selectionStart + '-' + q.selectionEnd; })()`);
  check('ctrl+a selects text', range, '0-10');
  await evaluate(`(() => { const q = document.getElementById('q'); q.value = ''; q.blur(); })()`);

  // in-app dialog: drawn by the page, keyboard answers, focus handed back
  // A known trigger, so the focus hand-back has one right answer instead of whatever happened to
  // be focused last: the search field is always on screen.
  await evaluate(`(() => { document.getElementById('q').focus(); window.__answer = 'waiting'; window.__back = document.activeElement.id || document.activeElement.tagName; ask({ title: 'SteaMar test', message: 'This is an in-app dialog.', ok: 'Remove', tone: 'bad' }).then((v) => { window.__answer = v; }); return 'asked'; })()`);
  let opened = 'missing';
  for (let i = 0; i < 20 && opened !== 'open'; i += 1) {
    await wait(100);
    opened = await evaluate(`!document.getElementById('dialog').hidden ? 'open' : 'closed'`);
  }
  check('dialog opens', opened, 'open');
  check('dialog title', await evaluate('document.getElementById("dialog-title").textContent'), 'SteaMar test');
  check('dialog has a question', await evaluate('document.getElementById("dialog-message").textContent.length > 10'), true);
  check('dialog takes focus', await evaluate('!!document.activeElement.closest("#dialog")'), true);
  check('page behind is inert', await evaluate('document.getElementById("main").inert'), true);
  for (const type of ['rawKeyDown', 'keyUp']) {
    await send('Input.dispatchKeyEvent', { type, windowsVirtualKeyCode: 27, code: 'Escape', key: 'Escape' });
  }
  await wait(150);
  check('escape means no', await evaluate('window.__answer'), false);
  check('dialog closed', await evaluate('document.getElementById("dialog").hidden'), true);
  check('focus goes back', await evaluate('window.__back'), await evaluate('document.activeElement.id') || await evaluate('document.activeElement.tagName'));

  // a destructive question: the way out is a button, the way on is the accent
  await evaluate(`window.__answer = 'waiting'; ask({ title: 'SteaMar test 2', message: 'Second question.', ok: 'remove', tone: 'bad' }).then((v) => { window.__answer = v; }); 'asked'`);
  await wait(150);
  check('cancel button exists', await evaluate('!!document.querySelector("[data-answer=\\"0\\"]")'), true);
  check('danger button reads remove', await evaluate('document.querySelector("[data-answer=\\"1\\"]").textContent.trim()'), 'remove');
  await evaluate(`document.querySelector('[data-answer="1"]').click(); 'clicked'`);
  await wait(150);
  check('confirm means yes', await evaluate('window.__answer'), true);

  // Enter is the same as the main button, without touching the mouse
  await evaluate(`window.__answer = 'waiting'; ask({ title: 'SteaMar test 3', message: 'Third question.', ok: 'ok' }).then((v) => { window.__answer = v; }); 'asked'`);
  await wait(150);
  for (const type of ['rawKeyDown', 'char', 'keyUp']) {
    await send('Input.dispatchKeyEvent', { type, windowsVirtualKeyCode: 13, code: 'Enter', key: 'Enter', text: type === 'char' ? '\r' : undefined });
  }
  await wait(150);
  check('enter means yes', await evaluate('window.__answer'), true);

  // the real button, not just ask(): settings → clear cached art raises the dialog and the way out cancels
  await evaluate(`location.hash = '#/settings'; 'moved'`);
  let settings_ready = false;
  for (let i = 0; i < 30 && !settings_ready; i += 1) {
    settings_ready = await evaluate(`Boolean(document.querySelector('[data-act="clear-cache"]'))`);
    if (!settings_ready) await wait(200);
  }
  check('settings button found', settings_ready, true);
  // The settings card re-renders while its numbers arrive, so a click can land on a node that is
  // about to be replaced. Press again rather than call the app slow.
  let cache_dialog = 'missing';
  for (let attempt = 0; attempt < 3 && cache_dialog !== 'Clear saved pictures?'; attempt += 1) {
    await evaluate(`document.querySelector('[data-act="clear-cache"]')?.click(); 'clicked'`);
    for (let i = 0; i < 12; i += 1) {
      await wait(100);
      cache_dialog = await evaluate(`!document.getElementById('dialog').hidden ? document.getElementById('dialog-title').textContent : 'missing'`);
      if (cache_dialog === 'Clear saved pictures?') break;
    }
  }
  check('cache dialog opens', cache_dialog, 'Clear saved pictures?');
  await evaluate(`document.querySelector('[data-answer="0"]')?.click(); 'cancelled'`);
  await wait(300);
  check('cache kept on No', (await evaluate('document.getElementById("toast").className')).includes('show'), false);

  // the setup path: either Steam has the files, or the panel must offer a way to get them
  check('status names its copy', await evaluate(`api('/api/status').then((s) => typeof s.root === 'string' && s.root.length > 3)`), true);
  check('setup has its files', await evaluate(`api('/api/setup').then((s) => Boolean(s.vendor && s.vendor.ready))`), true);
  check('setup panel acts', await evaluate(`(() => {
    const s = state.setup;
    if (!s) return 'no state';
    if (s.ready) return 'ready';
    return document.querySelector('[data-act="setup-install"], [data-act="setup-fetch"]') ? 'actions' : 'none';
  })()`), await evaluate(`state.setup && state.setup.ready ? 'ready' : 'actions'`));

  // the Denuvo tag is the whole story now: no filter chips, every game shows, tagged ones say so
  check('every game says if it is denuvo', await evaluate(`api('/api/library').then((l) => l.games.every((g) => typeof g.denuvo === 'boolean'))`), true);
  await evaluate(`location.hash = '#/library'; 'ok'`);
  await wait(500);
  check('no filter chips left', await evaluate(`document.querySelectorAll('.fchip, [data-df]').length`), 0);
  const shown = await evaluate(`(() => {
    const cards = [...document.querySelectorAll('#view-library .card')];
    const tagged = cards.filter((c) => {
      const mark = c.querySelector('.mark.drm');
      return mark && mark.getAttribute('aria-label') === 'Uses Denuvo';
    }).length;
    return JSON.stringify({ cards: cards.length, tagged });
  })()`);
  const counts = JSON.parse(shown);
  const library = await evaluate(`api('/api/library').then((l) => l.games.length)`);
  check('library shows every game', counts.cards, library);
  const tagged_games = await evaluate(`api('/api/library').then((l) => l.games.filter((g) => g.denuvo).length)`);
  check('every tagged game carries the tag', counts.tagged, tagged_games);

  // text size: one slider at the bottom of Settings, applied to the whole view by the shell
  const settle = async (expression, want) => {
    for (let i = 0; i < 25; i += 1) {
      if (String(await evaluate(expression)) === String(want)) return want;
      await wait(200);
    }
    return evaluate(expression);
  };
  const slide = async (percent) => {
    await evaluate(`(() => {
      const r = document.getElementById('zoom-range');
      r.value = '${percent}';
      r.dispatchEvent(new Event('input', { bubbles: true }));
      return r.value;
    })()`);
  };
  await evaluate(`location.hash = '#/settings'; 'ok'`);
  await wait(600);
  check('text size is a slider', await evaluate(`!!document.getElementById('zoom-range')`), true);
  check('slider runs 100 to 130', await evaluate(`(() => {
    const r = document.getElementById('zoom-range');
    return r.min + '-' + r.max + '-' + r.step;
  })()`), '100-130-5');
  // The order matters, the exact neighbours do not: Repair is only there when something is wrong,
  // so ask for the four permanent groups to be in order rather than for one fixed list of names.
  check('display sits above about', await evaluate(`(() => {
    const heads = [...document.querySelectorAll('#view-settings .group-head h3')].map((h) => h.textContent.trim());
    const at = (name) => heads.indexOf(name);
    const order = ['Steam', 'Display', 'About', 'Advanced'];
    const in_order = order.every((name, i) => at(name) >= 0 && (i === 0 || at(order[i - 1]) < at(name)));
    return in_order ? 'Steam < Display < About < Advanced' : heads.join(' > ');
  })()`), 'Steam < Display < About < Advanced');
  // The card is the first thing on the page, and it is tinted by what the checkup really found —
  // this machine is allowed to be in need of a repair, so the expected tint comes from the report.
  const card = JSON.parse(await evaluate(`(() => {
    const first = document.querySelector('#view-settings .settings').firstElementChild;
    const rep = state.repair;
    return JSON.stringify({
      is_card: first.classList.contains('status'),
      kind: first.classList.contains('ok') ? 'ok' : 'warn',
      want: rep && rep.summary.state === 'ok' ? 'ok' : 'warn',
      head: (first.querySelector('.status-text b') || {}).textContent || '',
    });
  })()`));
  check('steam status opens the page', `${card.is_card} ${card.kind}`, `true ${card.want}`);
  check('status card says what it found', card.head.length > 0, true);
  check('status card carries one action', await evaluate(`document.querySelectorAll('#view-settings .status .btn').length`), 1);

  // The checkup: real findings drive the card, and a broken setup has to be repairable by one press
  check('checkup answers', await evaluate(`api('/api/repair').then((r) => Array.isArray(r.findings) && ['ok', 'repair', 'blocked'].includes(r.summary.state))`), true);
  const health = await evaluate(`(() => {
    const rep = state.repair;
    const groups = [...document.querySelectorAll('#view-settings .group')];
    const repair = groups.find((g) => g.querySelector('h3').textContent.trim() === 'Repair');
    const open = rep.findings.filter((f) => f.severity !== 'info');
    return JSON.stringify({
      state: rep.summary.state,
      headline: document.querySelector('#view-settings .status-text b').textContent,
      rows: repair ? repair.querySelectorAll('.srow').length : 0,
      open: open.length,
      fix_buttons: repair ? repair.querySelectorAll('[data-act="repair-fix"]').length : 0,
      fixable: open.filter((f) => f.fixable).length,
    });
  })()`);
  const health_state = JSON.parse(health);
  check('card matches the checkup', health_state.headline, health_state.state === 'ok' ? 'Steam is set up' : 'Steam needs a small repair');
  check('settings keeps no repair list', await evaluate(`document.querySelectorAll('#view-settings [data-act^="repair-"]').length`), 0);
  check('settings still says what is wrong', health_state.headline, health_state.state === 'ok' ? 'Steam is set up' : 'Steam needs a small repair');

  // The repair is a step of the setup, and the card is the door to it: one sentence, one action.
  const repair_ui = JSON.parse(await evaluate(`(() => {
    const real = state.repair;
    const broken = {
      steam_root: real.steam_root,
      steam_running: false,
      findings: [{ id: 'dll-stale:dwmapi.dll', severity: 'fix', fixable: true, kind: 'dll', name: 'dwmapi.dll', action: 'fix', title: 'dwmapi.dll is not the one SteaMar ships', detail: 'a damaged or foreign copy' }],
      summary: { state: 'repair', fixable: 1, blockers: 0, warnings: 0, checked_at: new Date().toISOString() },
    };
    state.repair = broken;
    render_settings();
    const card = document.querySelector('#view-settings .status');
    const card_button = card.querySelector('.status-side button');
    render_setup();
    const title = document.getElementById('setup-title').textContent;
    const steps = [...document.querySelectorAll('#setup .sstep')];
    const first = steps[0] || {};
    const step_text = (first.textContent || '').toLowerCase();
    const fix_buttons = document.querySelectorAll('#setup [data-act="repair-now"]');
    const panel_text = document.getElementById('setup').textContent.toLowerCase();
    const panel = document.getElementById('setup');
    const was_open = !panel.hidden;
    state.repair = { ...broken, findings: [], summary: { ...broken.summary, state: 'ok' } };
    render_setup();
    const after = document.querySelectorAll('#setup [data-act="repair-now"]').length;
    state.repair = real;
    render_settings();
    render_setup();
    return JSON.stringify({
      headline: card.querySelector('.status-text b').textContent,
      card_act: card_button.dataset.act,
      card_label: card_button.textContent.trim(),
      first_step: (first.querySelector('b') || {}).textContent || '',
      title,
      step_number: (first.querySelector('.n') || {}).textContent || '',
      numbers: steps.map((s) => (s.querySelector('.n') || {}).textContent),
      numbers_in_order: steps.every((s, i) => Number((s.querySelector('.n') || {}).textContent) === i + 1),
      fix_buttons: fix_buttons.length,
      fix_label: fix_buttons[0] ? fix_buttons[0].textContent.trim() : '',
      step_text,
      panel_text,
      was_open,
      after,
    });
  })()`));
  check('card offers the repair', repair_ui.card_label, 'Repair');
  check('repair opens the setup steps', repair_ui.card_act, 'setup-open');
  check('setup says repair first', repair_ui.title, 'Steam needs a repair first');
  check('and the step says what to do', repair_ui.first_step, 'Repair first');
  check('it is the first step', repair_ui.step_number, '1');
  check('the steps still follow it', repair_ui.numbers_in_order, true);
  check('repair is one press', repair_ui.fix_buttons, 1);
  check('the press is called fix it', repair_ui.fix_label, 'Fix it');
  check('repair explains itself in words', repair_ui.step_text.includes('older setup'), true);
  // no file names, sizes or hashes: the person pressed fix, they did not ask for an audit
  const jargon = ['dll', 'bytes', 'sha', 'hash', 'quarantine', 'toml', 'registry'].filter((word) => repair_ui.panel_text.includes(word));
  check('repair says nothing technical', jargon.join(',') || 'plain', 'plain');
  check('a fixed setup drops the step', repair_ui.after, 0);

  check('settings talk like a person', await evaluate(`(() => {
    const text = document.querySelector('#view-settings').textContent.toLowerCase();
    return ['depot key', 'token', 'supplier', 'cache file'].filter((word) => text.includes(word)).join(',') || 'plain';
  })()`), 'plain');
  check('default size is large', await evaluate(`api('/api/status').then((s) => s.zoom >= 115)`), true);

  await slide(100);
  await settle('devicePixelRatio <= 1.01', true);
  const base_width = await evaluate('innerWidth');
  check('smaller text fits more', base_width > 0, true);
  await slide(130);
  check('larger text scales', await settle('devicePixelRatio > 1.29', true), true);
  check('larger shrinks the view', await settle(`innerWidth < ${Math.round(base_width * 0.85)}`, true), true);
  check('the number follows the slider', await evaluate(`document.getElementById('zoom-out').textContent`), '130%');
  check('status reports the size', await evaluate(`api('/api/status').then((s) => s.zoom)`), 130);

  await slide(115);
  check('back to large', await settle('devicePixelRatio > 1.13 && devicePixelRatio < 1.17', true), true);

  // The folder picker must ask about the folder that row already points at, otherwise it opens
  // wherever Windows remembers and the person has to navigate back to where they started.
  await evaluate(`location.hash = '#/settings'; 'ok'`);
  for (let i = 0; i < 40; i += 1) {
    if (await evaluate(`!!document.querySelector('#view-settings [data-pick]')`)) break;
    await wait(150);
  }
  const asked = await evaluate(`(async () => {
    const real = api;
    const seen = [];
    api = async (path, options) => {
      if (path === '/api/pick-folder') {
        seen.push({ ...JSON.parse(options.body), timeout: options.timeout || 0 });
        throw new Error('picker probe');
      }
      return real(path, options);
    };
    const buttons = [...document.querySelectorAll('#view-settings [data-pick]')];
    for (const button of buttons) button.click();
    await new Promise((r) => setTimeout(r, 400));
    api = real;
    return JSON.stringify(seen);
  })()`);
  const requests = JSON.parse(asked);
  const rows = await evaluate(`JSON.stringify((state.setup.folders || []).map((f) => ({ key: f.key, path: f.path })))`);
  const configured = JSON.parse(rows);
  check('picker asked for every row', requests.length, configured.length);
  check('picker was told the row', requests.every((r) => configured.some((c) => c.key === r.key)), true);
  check('picker starts at the current folder', requests.every((r) => {
    const row = configured.find((c) => c.key === r.key);
    return row && String(r.start).toLowerCase() === String(row.path).toLowerCase();
  }), true);
  check('picker names the folder', requests.every((r) => typeof r.title === 'string' && r.title.length > 8), true);
  check('picker waits for a person', requests.every((r) => r.timeout >= 600000), true);

  // the rescan button in the top bar has to be a recognisable circular arrow, and it has to work
  await evaluate(`location.hash = '#/library'; 'ok'`);
  await wait(500);
  const rescan = JSON.parse(await evaluate(`(async () => {
    const button = document.querySelector('[data-act="refresh"]');
    const glyph = button ? button.querySelector('svg') : null;
    const shapes = glyph ? [...glyph.children].map((n) => n.tagName) : [];
    // a glyph on a text baseline sits high in its button; the gaps have to match
    const gaps = (() => {
      if (!glyph) return null;
      const b = button.getBoundingClientRect(), g = glyph.getBoundingClientRect();
      return { top: +(g.top - b.top).toFixed(1), bottom: +(b.bottom - g.bottom).toFixed(1), left: +(g.left - b.left).toFixed(1), right: +(b.right - g.right).toFixed(1) };
    })();
    const before = document.querySelectorAll('#view-library .card').length;
    if (!button) return JSON.stringify({ shapes, busy: null, before, after: before, toast: 'no button', gaps });
    button.click();
    const busy = button.getAttribute('aria-busy');
    for (let i = 0; i < 100 && button.disabled; i += 1) await new Promise((r) => setTimeout(r, 100));
    return JSON.stringify({ shapes, busy, before, after: document.querySelectorAll('#view-library .card').length, toast: document.getElementById('toast').textContent, gaps });
  })()`));
  check('rescan glyph drawn', rescan.shapes.length > 0, true);
  check('rescan glyph is the family', rescan.shapes.every((t) => t === 'path' || t === 'circle' || t === 'rect'), true);
  check('rescan glyph is centred', Math.abs(rescan.gaps.top - rescan.gaps.bottom) <= 1.2 && Math.abs(rescan.gaps.left - rescan.gaps.right) <= 1.2, true);
  check('rescan shows it is busy', rescan.busy, 'true');
  check('rescan says it ran', rescan.toast, 'Library refreshed');
  check('rescan keeps the library', rescan.after, rescan.before);

  // Loading is the page's own shape, not a sentence: every block is drawn where the real one lands,
  // so the store arriving moves nothing. The numbers below come from the real page, not from a
  // constant, because a card that grows a line of small print must move the skeleton with it.
  const loading = JSON.parse(await evaluate(`(async () => {
    location.hash = '#/home';
    await new Promise((r) => setTimeout(r, 350));
    const view = document.querySelector('#view-home');
    const top = view.getBoundingClientRect().top;
    const at = (el) => (el ? Math.round(el.getBoundingClientRect().top - top) : -1);
    const real = state.store;
    state.store = null;
    state.store_error = '';
    render_home();
    await new Promise((r) => setTimeout(r, 120));
    const sk_banner = view.querySelector('.sk-banner');
    const sk_shelf = view.querySelector('.shelf');
    const sk_card = view.querySelector('.sk-card');
    const art = view.querySelector('.sk-art');
    const glow = getComputedStyle(art, '::after');
    const out = {
      text: view.textContent.trim(),
      cards: view.querySelectorAll('.sk-card').length,
      banner_h: Math.round(sk_banner.getBoundingClientRect().height),
      card_h: Math.round(sk_card.getBoundingClientRect().height),
      head_top: at(sk_shelf.querySelector('.page-head')),
      card_top: at(sk_card),
      art_ratio: +(art.getBoundingClientRect().width / art.getBoundingClientRect().height).toFixed(2),
      art_fill: getComputedStyle(art).backgroundColor,
      page_fill: getComputedStyle(document.body).backgroundColor,
      glow: glow.animationName,
      glow_s: glow.animationDuration,
    };
    state.store = real;
    render_home();
    await new Promise((r) => setTimeout(r, 300));
    const real_banner = view.querySelector('.banner');
    const real_card = view.querySelector('.card');
    const real_art = real_card.querySelector('.art');
    out.real_banner_h = Math.round(real_banner.getBoundingClientRect().height);
    out.real_card_h = Math.round(real_card.getBoundingClientRect().height);
    out.real_ratio = +(real_art.getBoundingClientRect().width / real_art.getBoundingClientRect().height).toFixed(2);
    out.real_head_top = at(view.querySelector('.shelf .page-head'));
    out.real_card_top = at(real_card);
    out.after = view.querySelectorAll('.sk').length;
    return JSON.stringify(out);
  })()`));
  const mean = (rgb) => rgb.match(/\d+/g).map(Number).reduce((a, b) => a + b, 0) / 3;
  check('loading draws shapes, not a sentence', loading.text, '');
  check('loading has a banner block', loading.banner_h, loading.real_banner_h);
  check('loading has four cards a shelf', loading.cards, 8);
  check('loading cards match the real ones', Math.abs(loading.art_ratio - loading.real_ratio) <= 0.05, true);
  // Within a hairline is exact: text lines land on fractions, so a bar can round a pixel off.
  const within = (pairs) => {
    const off = pairs.find(([a, b]) => Math.abs(a - b) > 1);
    return off ? `${off[0]} vs ${off[1]}` : 'within a pixel';
  };
  check('loading cards are the real height', within([[loading.card_h, loading.real_card_h]]), 'within a pixel');
  check('loading keeps the real rhythm', within([[loading.head_top, loading.real_head_top], [loading.card_top, loading.real_card_top]]), 'within a pixel');
  // A skeleton nobody can see is an empty page with a delay.
  check('loading blocks lift off the page', mean(loading.art_fill) - mean(loading.page_fill) >= 12, true);
  check('loading shows that work is happening', ['sk-sweep', 'sk-breathe'].includes(loading.glow), true);
  check('and it is a slow breath, not a strobe', ['1.5s', '2.4s'].includes(loading.glow_s), true);
  check('loading clears when the store lands', loading.after, 0);

  // A failure is not a longer wait: the skeleton has to give way to a reason and one button.
  const broken_store = JSON.parse(await evaluate(`(() => {
    const real = state.store;
    state.store = null;
    state.store_error = 'the store answered HTTP 503';
    render_home();
    const text = document.querySelector('#view-home').textContent.replace(/\\s+/g, ' ').trim();
    const retry = document.querySelector('#view-home [data-act="store-retry"]');
    const skeletons = document.querySelectorAll('#view-home .sk').length;
    state.store = real;
    state.store_error = '';
    render_home();
    return JSON.stringify({ text, retry: Boolean(retry), skeletons });
  })()`));
  check('a failed store stops pretending to load', broken_store.skeletons, 0);
  check('a failed store says so in words', broken_store.text.includes("didn't load") && !broken_store.text.includes('503'), true);
  check('a failed store offers a retry', broken_store.retry, true);

  // Buttons that share a row share a height. The drawer used to put a 36px install next to a
  // 28px remove, which reads as two different kinds of control for two things you pick between.
  const button_rows = JSON.parse(await evaluate(`(async () => {
    const heights = (root) => [...root.querySelectorAll('.btn')].map((b) => Math.round(b.getBoundingClientRect().height));
    const same = (list) => list.length > 0 && list.every((h) => h === list[0]);

    location.hash = '#/library';
    await new Promise((r) => setTimeout(r, 700));
    document.querySelector('#view-library .card').click();
    await new Promise((r) => setTimeout(r, 600));
    const drawer = heights({ querySelectorAll: (s) => document.querySelectorAll('#drawer .actions ' + s) });
    const drawer_labels = [...document.querySelectorAll('#drawer .actions .btn')].map((b) => b.textContent.trim());

    location.hash = '#/settings';
    await new Promise((r) => setTimeout(r, 700));
    const side_rows = [...document.querySelectorAll('#view-settings .srow-side')].map((side) => heights(side)).filter((list) => list.length);
    const settings_row = side_rows.flat();

    const real_setup = state.setup;
    state.setup = { ...real_setup, ready: false, steam_running: false };
    render_setup();
    document.getElementById('setup').hidden = false;
    const step_rows = [...document.querySelectorAll('#setup .sstep')].map((r) => heights(r));
    const foot = heights(document.querySelector('#setup .setup-foot'));
    state.setup = real_setup;
    render_setup();
    document.getElementById('setup').hidden = true;
    document.getElementById('scrim').hidden = true;

    return JSON.stringify({
      drawer,
      drawer_labels,
      drawer_same: same(drawer),
      settings_row,
      settings_groups: side_rows.length,
      settings_same: side_rows.every(same),
      steps: step_rows,
      steps_same: step_rows.every((row) => same(row)),
      foot,
    });
  })()`));
  check('install and remove are one size', button_rows.drawer_same, true);
  check('install and remove are both there', button_rows.drawer_labels.join(','), 'Install,Remove');

  // A panel that only offers a button asks the person to know what the thing is. It says what the
  // game is instead: one sentence from the store, four facts, no price anywhere, and the same
  // cover box whether the store keeps a header or a hero.
  const about = JSON.parse(await evaluate(`(async () => {
    location.hash = '#/home';
    await new Promise((r) => setTimeout(r, 800));
    if (!state.store) { try { await load_store(true); } catch (e) {} }
    const card = document.querySelector('#view-home .card[data-appid]');
    card.click();
    for (let i = 0; i < 40; i += 1) {
      await new Promise((r) => setTimeout(r, 150));
      if (document.querySelectorAll('#drawer .dabout .dfact').length) break;
    }
    const drawer = document.getElementById('drawer');
    const picture = drawer.querySelector('.dhero');
    const out = {
      appid: card.dataset.appid,
      open: !drawer.hidden,
      facts: [...drawer.querySelectorAll('.dfact')].map((f) => f.querySelector('i').textContent),
      desc: (drawer.querySelector('.ddesc') || {}).textContent || '',
      picture_h: picture ? Math.round(picture.getBoundingClientRect().height) : 0,
      money: /[$€£¥]/.test(drawer.textContent),
      skeletons: drawer.querySelectorAll('#drawer .dabout .sk').length,
    };
    close_drawer();
    return JSON.stringify(out);
  })()`));
  check('the panel says what the game is', about.desc.length > 40, true);
  check('the panel lines up the facts', about.facts.length >= 2 && about.facts.some((f) => f === 'released' || f === 'coming'), true);
  check('the facts are lowercase like the rest', about.facts.every((f) => f === f.toLowerCase()), true);
  // The picture is one box whatever art fills it, so the window does not move when the hero lands.
  check('the panel keeps one picture box', about.picture_h, 236);
  check('the panel shows no price', about.money, false);
  check('the panel stopped pretending to load', about.skeletons, 0);

  // A game the store will not talk about still has a job to offer, and says nothing it cannot back.
  const about_missing = JSON.parse(await evaluate(`(async () => {
    open_drawer('999999999', { name: 'nothing' });
    // Wait for the details call to settle, not for a fixed guess: a slow answer is still an answer.
    for (let i = 0; i < 60; i += 1) {
      await new Promise((r) => setTimeout(r, 150));
      if (!document.querySelector('#drawer .dabout .sk')) break;
    }
    const drawer = document.getElementById('drawer');
    const out = {
      about: Boolean(drawer.querySelector('.dabout')),
      buttons: drawer.querySelectorAll('.actions .btn').length,
      text: drawer.textContent.replace(/\\s+/g, ' ').trim(),
      undefined: drawer.textContent.includes('undefined'),
    };
    close_drawer();
    return JSON.stringify(out);
  })()`));
  check('a silent store keeps one job', about_missing.buttons, 1);
  check('and says why that is the only one', about_missing.text.includes("Can't be added yet") && !about_missing.text.includes('999999999'), true);
  check('and adds nothing of its own', about_missing.about, false);
  check('and no placeholder words', about_missing.undefined, false);

  // A refresh that lands while a panel is open is not a move between views, so it leaves it alone.
  const panel_holds = JSON.parse(await evaluate(`(async () => {
    location.hash = '#/library';
    await new Promise((r) => setTimeout(r, 500));
    document.querySelector('#view-library .card').click();
    await new Promise((r) => setTimeout(r, 400));
    await route();
    const after_refresh = !document.getElementById('drawer').hidden;
    location.hash = '#/settings';
    await new Promise((r) => setTimeout(r, 500));
    const after_move = document.getElementById('drawer').hidden;
    return JSON.stringify({ after_refresh, after_move });
  })()`));
  check('a refresh leaves the panel alone', panel_holds.after_refresh, true);
  check('a move to another view closes it', panel_holds.after_move, true);

  // A game that costs nothing needs no script: the panel says so, dims the add button instead of
  // hiding it, and sends the person to Steam. Pressing the dimmed one explains itself.
  const free_game = JSON.parse(await evaluate(`(async () => {
    const details = await api('/api/app?appid=440');
    open_drawer('440', { name: details.name || 'Team Fortress 2' });
    for (let i = 0; i < 40; i += 1) {
      await new Promise((r) => setTimeout(r, 150));
      if (document.querySelector('#drawer .dstate.free')) break;
    }
    const drawer = document.getElementById('drawer');
    const add = drawer.querySelector('[data-free-blocked]');
    const primary = drawer.querySelector('.actions .btn');
    const before = state.library.length;
    if (add) add.click();
    await new Promise((r) => setTimeout(r, 300));
    const toast_text = document.getElementById('toast').textContent;
    const out = {
      free_here: Boolean(details.free),
      state: (drawer.querySelector('.dstate') || {}).textContent || '',
      primary: primary ? primary.textContent.trim() : '',
      primary_act: primary ? primary.dataset.install || '' : '',
      blocked: add ? add.getAttribute('aria-disabled') : 'missing',
      tooltip: add ? add.title : '',
      hint: (drawer.querySelector('.hint') || {}).textContent || '',
      facts: [...drawer.querySelectorAll('.dfact i')].map((f) => f.textContent),
      toast: toast_text,
      added: state.library.length - before,
    };
    close_drawer();
    return JSON.stringify(out);
  })()`));
  check('the free panel knows the game is free', free_game.free_here, true);
  check('it says so at the top', free_game.state, 'Free on Steam.');
  check('the main button goes to Steam', `${free_game.primary}|${free_game.primary_act}`, 'Get it on Steam|440');
  check('add is dimmed, not gone', free_game.blocked, 'true');
  check('the tooltip says why', free_game.tooltip.includes('nothing to add'), true);
  check('the hint explains the one button', free_game.hint.includes('straight from Steam'), true);
  check('pressing the dimmed button explains itself', free_game.toast.includes('Get it from Steam'), true);
  check('and adds nothing', free_game.added, 0);
  check('free is said once, at the top', free_game.facts.includes('on steam'), false);

  // is_free answers true for demos and for free games that have not shipped, and both were being
  // told the flat "Free on Steam!" line with an installer button that cannot work yet.
  const free_kinds = JSON.parse(await evaluate(`(async () => {
    const look = async (appid, detail) => {
      const before = state.details[appid];
      state.details[appid] = {
        appid, fetched: Date.now(), coming_soon: false, type: 'game', description: '',
        genres: [], players: [], developers: [], release: null, ...detail,
      };
      await open_drawer(appid, { name: detail.name });
      const drawer = document.getElementById('drawer');
      const add = drawer.querySelector('[data-free-blocked]');
      const primary = drawer.querySelector('.actions .btn');
      if (add) add.click();
      await new Promise((r) => setTimeout(r, 250));
      const out = {
        state: (drawer.querySelector('.dstate') || {}).textContent || '',
        label: primary ? primary.textContent.trim() : '',
        store: primary ? primary.dataset.store || '' : '',
        install: primary ? primary.dataset.install || '' : '',
        tip: add ? add.title : '',
        toast: document.getElementById('toast').textContent,
      };
      close_drawer();
      if (before === undefined) delete state.details[appid];
      else state.details[appid] = before;
      return out;
    };
    return JSON.stringify({
      demo: await look('3482', { name: 'Peggle Deluxe Free Demo', free: true, type: 'demo' }),
      soon: await look('5547370', { name: 'A free game that is not out', free: true, coming_soon: true }),
    });
  })()`));
  check('a demo says it is a demo', free_kinds.demo.state, 'A free demo on Steam.');
  check('a demo still sends you to Steam', free_kinds.demo.install, '3482');
  check('the demo tooltip is about the demo', free_kinds.demo.tip.includes('Demos are free'), true);
  check('pressing add on a demo explains itself', free_kinds.demo.toast.includes('free demo'), true);
  check('a free game that is not out says so', free_kinds.soon.state, 'Not out yet.');
  check('and opens the store page, not an installer', `${free_kinds.soon.label}|${free_kinds.soon.store}`, 'Open the store page|5547370');
  check('with no installer to fail', free_kinds.soon.install, '');

  // Denuvo is a chip, not a filter: it rides on a card, and it has to ride into the search results and
  // the panel the same way, or the panel is the one place a person cannot find out.
  const drm = JSON.parse(await evaluate(`(async () => {
    const frag = document.createElement('div');
    frag.innerHTML = search_html('x', [
      { appid: '2358720', name: 'Black Myth: Wukong', denuvo: true },
      { appid: '440', name: 'Team Fortress 2', denuvo: false },
    ]);
    const rows = [...frag.querySelectorAll('.card')];
    const before = state.details['2358720'];
    state.details['2358720'] = {
      appid: '2358720', fetched: Date.now(), name: 'Black Myth: Wukong', free: false, type: 'game',
      description: '', genres: [], players: [], developers: [], release: null, denuvo: true,
    };
    await open_drawer('2358720', { name: 'Black Myth: Wukong', denuvo: true });
    const head = document.querySelector('#drawer .dhead');
    const out = {
      row_chip: rows[0].querySelector('.mark.drm')?.getAttribute('aria-label') || '',
      row_flag: rows[0].dataset.denuvo || '',
      clean_row: Boolean(rows[1].querySelector('.mark.drm')),
      clean_flag: rows[1].dataset.denuvo || '',
      panel: [...head.querySelectorAll('.dchips .chip')].map((c) => c.textContent).join(','),
    };
    close_drawer();
    if (before === undefined) delete state.details['2358720'];
    else state.details['2358720'] = before;
    return JSON.stringify(out);
  })()`));
  check('a search card says denuvo', drm.row_chip, 'Uses Denuvo');
  check('and carries the fact for the panel', drm.row_flag, '1');
  check('a card for a game without it stays clean', `${drm.clean_row}|${drm.clean_flag}`, 'false|');
  check('the panel says denuvo too', drm.panel, 'Uses Denuvo');

  const drm_app = JSON.parse(await evaluate(`(async () => {
    const yes = await api('/api/app?appid=2358720');
    const no = await api('/api/app?appid=440');
    return JSON.stringify({ yes: Boolean(yes.denuvo), no: Boolean(no.denuvo) });
  })()`));
  check('the details call carries the drm flag', drm_app.yes, true);
  check('and only for the games that use it', drm_app.no, false);

  const free_clock = JSON.parse(await evaluate(`(async () => {
    const first = await api('/api/app?appid=730');
    const second = await api('/api/app?appid=730');
    return JSON.stringify({
      has_stamp: Number.isFinite(first.free_at),
      age_s: Math.round((Date.now() - first.free_at) / 1000),
      reused: first.free_at === second.free_at,
      free: first.free,
    });
  })()`));
  check('the free verdict carries its own clock', free_clock.has_stamp, true);
  check('and it is never older than a day', free_clock.age_s < 86400, true);
  check('a second open does not ask again', free_clock.reused, true);
  check('a free game still reads free', free_clock.free, true);

  const drm_none = JSON.parse(await evaluate(`(async () => {
    await open_drawer('440', { name: 'Team Fortress 2' });
    await new Promise((r) => setTimeout(r, 500));
    const box = document.querySelector('#drawer .dchips');
    const out = { chips: box.querySelectorAll('.chip').length, h: Math.round(box.getBoundingClientRect().height) };
    close_drawer();
    return JSON.stringify(out);
  })()`));
  check('no chip leaves no gap', `${drm_none.chips}|${drm_none.h}`, '0|0');

  // A free game that is already in the library gets the dry line, not a lecture.
  const free_owned = JSON.parse(await evaluate(`(async () => {
    const g = state.library.find((x) => x.valid);
    const before = state.details[g.appid];
    state.details[g.appid] = {
      appid: g.appid, fetched: Date.now(), name: g.name, free: true, type: 'game',
      description: (before && before.description) || '', genres: [], players: [], developers: [], release: null,
    };
    await open_drawer(g.appid, { file: g.file, name: g.name });
    const drawer = document.getElementById('drawer');
    const out = {
      labels: [...drawer.querySelectorAll('.actions .btn')].map((b) => b.textContent.trim()),
      hint: (drawer.querySelector('.hint') || {}).textContent || '',
      facts: [...drawer.querySelectorAll('.dfact i')].map((f) => f.textContent),
    };
    close_drawer();
    if (before === undefined) delete state.details[g.appid];
    else state.details[g.appid] = before;
    return JSON.stringify(out);
  })()`));
  check('an owned free game still offers install', free_owned.labels.join(','), 'Install,Remove');
  check('and gets the dry line', free_owned.hint.includes('free on Steam anyway'), true);
  check('and no repeated free fact', free_owned.facts.includes('on steam'), false);

  // Focus goes into the panel, the title bar stays put while it scrolls, and closing gives focus
  // back to the card that opened it.
  const focus_flow = JSON.parse(await evaluate(`(async () => {
    location.hash = '#/library';
    await new Promise((r) => setTimeout(r, 600));
    const card = document.querySelector('#view-library .card');
    card.focus();
    card.click();
    await new Promise((r) => setTimeout(r, 500));
    const drawer = document.getElementById('drawer');
    const out = {
      role: drawer.getAttribute('role'),
      modal: drawer.getAttribute('aria-modal'),
      labelled: drawer.getAttribute('aria-labelledby'),
      title_id: Boolean(document.getElementById('drawer-title')),
      in_panel: document.activeElement === drawer,
      scrolls: getComputedStyle(drawer.querySelector('.dbody')).overflowY,
    };
    close_drawer();
    await new Promise((r) => setTimeout(r, 120));
    out.back = document.activeElement === card;
    out.main_free = document.getElementById('main').inert;
    return JSON.stringify(out);
  })()`));
  check('the panel is a dialog to a screen reader', `${focus_flow.role}/${focus_flow.modal}/${focus_flow.labelled}`, 'dialog/true/drawer-title');
  check('and its title has the id it points at', focus_flow.title_id, true);
  check('the panel takes focus when it opens', focus_flow.in_panel, true);
  check('only the text scrolls, under a title that stays', focus_flow.scrolls, 'auto');
  check('closing puts focus back on the card', focus_flow.back, true);
  check('and the page behind works again', focus_flow.main_free, false);

  // One panel per press: the next one opens at the top, not wherever the last one was left, and it
  // stops saying it is busy once the store has answered.
  const panel_reset = JSON.parse(await evaluate(`(async () => {
    location.hash = '#/library';
    await new Promise((r) => setTimeout(r, 500));
    const cards = [...document.querySelectorAll('#view-library .card')];
    cards[0].click();
    await new Promise((r) => setTimeout(r, 700));
    document.querySelector('#drawer .dbody').scrollTop = 220;
    close_drawer();
    cards[1].click();
    await new Promise((r) => setTimeout(r, 900));
    const out = { after: document.querySelector('#drawer .dbody').scrollTop, busy: document.getElementById('drawer').getAttribute('aria-busy') };
    close_drawer();
    return JSON.stringify(out);
  })()`));
  check('a second panel starts at the top', panel_reset.after, 0);
  check('and stops saying it is busy', panel_reset.busy, 'false');
  check('settings rows are one size', button_rows.settings_same, true);
  check('setup steps are one size', button_rows.steps_same, true);

  // The update channel, as the page draws it. The service is stubbed for this one: the point is that
  // a published release becomes exactly one row with one button, and that nothing is drawn when the
  // build is current. Both states are put back afterwards, so the check leaves the page as it found it.
  // The update channel, as the page draws it. The service is stubbed for this one: the point is that
  // a published release becomes exactly one row with one button, that a current build still says so
  // in a row, and that the row is never simply absent. Every stub is put back afterwards.
  const update_row = JSON.parse(await evaluate(`(() => {
    const original = state.settings;
    const draw = (update) => {
      const copy = JSON.parse(JSON.stringify(original));
      if (update) copy.app.update = update; else delete copy.app.update;
      state.settings = copy;
      render_settings();
      const rows = [...document.querySelectorAll('#view-settings .srow')];
      const row = rows.find((r) => /latest version|is available|update required|updates/i.test(r.textContent));
      const found = row ? {
        label: row.querySelector('b').textContent.trim(),
        note: row.querySelector('em').textContent.trim(),
        button: Boolean(row.querySelector('[data-act="update"]')),
        check: Boolean(row.querySelector('[data-act="update-check"]')),
        url: row.querySelector('[data-act="update"]')?.dataset.url || null,
      } : null;
      state.settings = original;
      return found;
    };
    const newer = draw({ state: 'optional', version: '0.5.1', url: 'https://steamar.cc/download/SteaMar.exe', notes: 'a newer one', checked_at: new Date().toISOString() });
    const old = draw({ state: 'required', version: '0.6.0', url: 'https://steamar.cc/download/SteaMar.exe' });
    const none = draw({ state: 'none', version: null, url: null, checked_at: new Date().toISOString() });
    const unknown = draw({ state: 'unknown', version: null, url: null, note: 'the service has no update channel' });
    render_settings();
    return JSON.stringify({ newer, old, none, unknown });
  })()`));
  check('an update shows as one row', update_row.newer?.label, 'Version 0.5.1 is available');
  check('the row carries the notes', update_row.newer?.note, 'a newer one');
  check('and one button to get it', update_row.newer?.button, true);
  check('the button takes the signed url', update_row.newer?.url, 'https://steamar.cc/download/SteaMar.exe');
  check('a required update says so', update_row.old?.label, 'Update required');
  check('a current build says so too', update_row.none?.label, 'You have the latest version');
  check('and offers a check instead', update_row.none?.check, true);
  check('a silent service is its own row', update_row.unknown?.label, 'Updates');

  // The pre-flight and the report counter, as they reach a card: a dead title says it cannot be
  // added, a reported one says how many machines failed, and a clean title says nothing at all.
  // Drawn by the search page itself, not by a stub of it.
  const finder_why = JSON.parse(await evaluate(`(() => {
    const host = document.createElement('div');
    // The dead title is hidden by default; the switch beside the search shows it.
    const was = search_show.unavailable;
    search_show.unavailable = true;
    host.innerHTML = search_html('x', [
      { appid: '730', name: 'Counter-Strike 2', renderable: true, partial: true, reason: '4 of 15 depots have no key here', reports: { total: 5, fails: 2, last_outcome: 'stalled' } },
      { appid: '4348910', name: 'No Keys At All', renderable: false, partial: false, reason: 'the service holds no data for 4348910', reports: null },
      { appid: '400', name: 'Portal', renderable: true, partial: false, reason: null, reports: { total: 2, fails: 0 } },
    ]);
    search_show.unavailable = was;
    const cards = [...host.querySelectorAll('.card')];
    const why = (i) => [...cards[i].querySelectorAll('.meta.bad, .mark.bad')].map((el) => ({ text: el.getAttribute('aria-label') || el.textContent.trim(), bad: true }));
    return JSON.stringify({
      partial: why(0), dead: why(1), clean: why(2),
      partial_button: cards[0].dataset.appid || null,
      dead_button: cards[1].querySelector('.mark.bad')?.getAttribute('aria-label') || null,
    });
  })()`));
  // A partial title says nothing about it: it still goes into Steam, which is all a person needs.
  check('a partial card does not warn about it', finder_why.partial?.length, 1);
  check('but counts the people it failed for', finder_why.partial?.[0]?.text, "Didn't work for others 2 of 5 times");
  check('a partial card still opens its window', finder_why.partial_button, '730');
  check('a dead card says why', finder_why.dead?.[0]?.bad, true);
  check('and says it cannot be added', /not available/i.test(finder_why.dead_button || ''), true);
  check('a clean card says nothing', finder_why.clean?.length, 0);

  // The same sentence in the panel, under the buttons, where a person reads it before pressing.
  const note = JSON.parse(await evaluate(`JSON.stringify({
    failed: report_note({ total: 5, fails: 2, last_outcome: 'stalled', last_at: new Date(Date.now() - 3600000).toISOString() }),
    clean: report_note({ total: 3, fails: 0, last_at: new Date().toISOString() }),
    none: report_note(null),
  })`));
  check('the panel counts the failures', note.failed.includes("Didn't work for other people 2 of 5 times"), true);
  check('a clean record reads as clean', note.clean.includes('with no problems'), true);
  check('no report means no line', note.none, '');

  // The two corners: titles other machines reported, and a build that is not the newest. Both are
  // read from the status bar, the one strip that is on every page.
  const corner = JSON.parse(await evaluate(`(() => {
    const reach = state.reach;
    const settings = state.settings;
    state.reach = { ...(reach || {}), failing: 2, failing_titles: [{ appid: '730', total: 5, fails: 2 }, { appid: '620', total: 3, fails: 1 }] };
    state.settings = { ...(settings || {}), app: { ...((settings && settings.app) || {}), update: { state: 'optional', version: '0.5.1', url: 'https://steamar.cc/download/SteaMar.exe' } } };
    render_status();
    const text = document.getElementById('statusbar').textContent;
    const href = document.querySelector('#statusbar a')?.getAttribute('href') || null;
    const title = document.querySelector('#statusbar .v.warn[title]')?.getAttribute('title') || null;
    state.reach = reach;
    state.settings = settings;
    render_status();
    return JSON.stringify({ text, href, title });
  })()`));
  check('the status bar leaves failure counts to the panels', corner.text.includes('reported failing'), false);
  check('a newer build gets a corner', corner.text.includes('Update available'), true);
  check('that leads to the row that fixes it', corner.href, '#/settings');

  await evaluate(`setTimeout(() => { throw new Error('self-test boom'); }, 0); 'thrown'`);
  await evaluate(`setTimeout(() => { throw new Error('self-test boom'); }, 0); 'thrown'`);
  let crash_dialog = 'missing';
  for (let i = 0; i < 20 && crash_dialog !== 'Something went wrong'; i += 1) {
    await wait(100);
    crash_dialog = await evaluate(`document.getElementById('dialog').hidden ? 'missing' : document.getElementById('dialog-title').textContent`);
  }
  check('error dialog', crash_dialog, 'Something went wrong');
  // The person sees plain words; the error itself goes to out/native.log through report().
  check('error speaks plainly', await evaluate(`document.getElementById('dialog-message').textContent.includes('self-test boom')`), false);
  check('and shows no stack', await evaluate(`!document.querySelector('.dialog-detail')`), true);
  check('dialog buttons are one size', await evaluate(`(() => {
    const list = [...document.querySelectorAll('.dialog-foot .btn')].map((b) => Math.round(b.getBoundingClientRect().height));
    return list.length > 1 && list.every((h) => h === list[0]);
  })()`), true);
  await evaluate(`document.querySelector('[data-answer="1"]').click(); 'closed'`);
  await wait(200);
  check('error dialog closes', await evaluate(`document.getElementById('dialog').hidden`), true);

  ws.close();
  execFileSync('taskkill', ['/IM', 'SteaMar.exe', '/F'], { stdio: 'ignore' });
  console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
  if (failed) process.exitCode = 1;
})().catch((err) => {
  console.error('fail', err.message);
  try { execFileSync('taskkill', ['/IM', 'SteaMar.exe', '/F'], { stdio: 'ignore' }); } catch {}
  process.exit(1);
});
