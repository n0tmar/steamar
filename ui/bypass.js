'use strict';

// The Bypass view: the games the service holds a bypass for, as cards, and the window one of them
// opens - the same window a game opens from Home, with the words that go with it and a download button.
// Trap: the download runs in the engine; the window asks how far it got twice a second, and stops
// asking when it closes or shows something else.

let bypass_games = null;
let bypass_sig = '';
const bypass_following = new Set();

const bypass_card = (g, i) => `
    <button class="card" data-bypass="${esc(g.appid)}" title="${esc(g.name)}">
      <div class="art" data-name="${esc(g.name)}">
        <img src="${esc(g.image)}" alt="" width="460" height="215" loading="${i < 8 ? 'eager' : 'lazy'}" decoding="async" onerror="this.parentNode.classList.add('noart');this.remove()">
        ${marks_html(g.denuvo ? ['denuvo'] : [])}
      </div>
      <span class="name">${esc(g.name)}</span>
      <span class="meta">${esc(kb(Number(g.size) || 0))}${g.updated ? ` · ${esc(day_label(g.updated))}` : ''}</span>
    </button>`;

// Asked each time the tab opens, and drawn again only when the answer changed, so the covers do not
// fade in again on every visit.
async function render_bypass() {
  const view = $('view-bypass');
  if (!bypass_games) view.innerHTML = `<div class="grid">${[0, 1, 2, 3].map(sk_card).join('')}</div>`;
  let games;
  try {
    games = (await api('/api/bypass')).games || [];
  } catch (err) {
    if (bypass_games) return; // what is on screen is still the best answer there is
    bypass_sig = '';
    view.innerHTML = `
      <div class="empty">
        <p>The bypass list didn't load</p>
        <p class="hint">${esc(err.message)}</p>
        <p><button class="btn sm" data-act="bypass-retry">${icon('refresh')}Try again</button></p>
      </div>`;
    return;
  }
  bypass_games = games;
  const sig = JSON.stringify(games.map((g) => [g.appid, g.name, g.size, g.updated, g.text, g.denuvo]));
  if (sig === bypass_sig) return;
  bypass_sig = sig;
  view.innerHTML = games.length
    ? `${note_bar(`${games.length} game${games.length === 1 ? '' : 's'}, newest first`)}
       <div class="grid">${games.map(bypass_card).join('')}</div>`
    : `<div class="empty">
         <p>No bypasses yet</p>
         <p class="hint">When one is added, it shows up here.</p>
       </div>`;
}

/* ---------- the window ---------- */

// The owner writes a game's words as plain lines, such as "2. Right-click the game > Manage > Browse
// local files". A numbered line is drawn as a step and " > " as an arrow, so a menu path reads at a
// glance. An older build shows the same file as text, and it still reads. Arabic digits count too.
const STEP = /^([0-9\u0660-\u0669]{1,2})[.)]\s+(.+)$/;

function steps_html(text) {
  const lines = String(text).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return `<div class="bp-steps">${lines.map((line) => {
    const hit = STEP.exec(line);
    const say = (hit ? hit[2] : line).split(/\s+>\s+/).map(esc).join(`<span class="bp-gt">${icon('right')}</span>`);
    if (hit) return `<div class="bp-step" dir="auto"><span class="bp-n">${esc(hit[1])}</span><span>${say}</span></div>`;
    const done = /^done\b/i.test(line);
    return `<p class="bp-line${done ? ' ok' : ''}" dir="auto">${done ? icon('check') : ''}<span>${say}</span></p>`;
  }).join('')}</div>`;
}

function bypass_body(g, job) {
  const id = esc(g.appid);
  const size = Number(g.size) ? ` · ${kb(Number(g.size))}` : '';
  let line = `<p class="dstate">Ready to download${esc(size)}.</p>`;
  let buttons = `<button class="btn primary wide" data-act="bypass-get" data-appid="${id}">${icon('download')}Download</button>`;
  let hint = 'It is saved to your Downloads folder as a zip.';
  if (job.state === 'downloading') {
    line = `<p class="dstate">Downloading${esc(size)}.</p>`;
    buttons = `<button class="btn primary wide" disabled>${icon('download')}Downloading ${Number(job.percent) || 0}%</button>`;
    hint = 'You can close this window. The download keeps going.';
  } else if (job.state === 'done') {
    line = '<p class="dstate ok">Downloaded.</p>';
    buttons = `<button class="btn primary wide" data-act="bypass-show" data-appid="${id}">${icon('folder')}Show in folder</button>
        <button class="btn ghost" data-act="bypass-get" data-appid="${id}">${icon('download')}Download again</button>`;
    hint = `Saved in Downloads as ${esc(String(job.file || '').split(/[\\/]/).pop())}.`;
  } else if (job.state === 'failed') {
    line = '<p class="dstate bad">The download didn\'t finish.</p>';
    buttons = `<button class="btn primary wide" data-act="bypass-get" data-appid="${id}">${icon('refresh')}Try again</button>`;
    hint = esc(job.error || 'Check your internet connection, then try again.');
  }
  return `${line}<div class="actions">${buttons}</div><p class="hint">${hint}</p>${
    g.text ? `<div class="dabout">${steps_html(g.text)}</div>` : ''}`;
}

function paint_bypass(drawer, g, job) {
  const body = drawer.querySelector('.dbody');
  if (!body) return;
  const sig = `bypass:${job.state}:${job.percent}`;
  if (body.dataset.sig === sig) return;
  body.dataset.sig = sig;
  body.innerHTML = bypass_body(g, job);
}

function open_bypass(appid) {
  const g = (bypass_games || []).find((one) => one.appid === String(appid));
  if (!g) return;
  const drawer = show_drawer(`bypass:${g.appid}`);
  drawer.innerHTML = drawer_frame(g.image, g.name);
  paint_hero(drawer, g.appid, g.hero);
  paint_denuvo(drawer, Boolean(g.denuvo));
  paint_bypass(drawer, g, g.job || { state: 'idle', percent: 0 });
  drawer.setAttribute('aria-busy', 'false');
  drawer.focus();
  follow_bypass(g);
}

// How far the engine got, while the window shows this game and the download is running.
async function follow_bypass(g) {
  if (bypass_following.has(g.appid)) return;
  bypass_following.add(g.appid);
  const drawer = $('drawer');
  try {
    for (;;) {
      const job = await api(`/api/bypass/download?appid=${encodeURIComponent(g.appid)}`);
      if (drawer.hidden || drawer.dataset.shows !== `bypass:${g.appid}`) return;
      paint_bypass(drawer, g, job);
      if (job.state !== 'downloading') return;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  } catch { /* the engine went away; the window keeps the last answer it had */ } finally {
    bypass_following.delete(g.appid);
  }
}

async function bypass_get(el) {
  const appid = el.dataset.appid;
  el.disabled = true;
  try {
    await api('/api/bypass/download', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appid }),
    });
  } catch (err) {
    el.disabled = false;
    toast(err.message, true);
    return;
  }
  const g = (bypass_games || []).find((one) => one.appid === String(appid));
  if (g) follow_bypass(g);
}

async function bypass_show(appid) {
  try {
    await api('/api/bypass/show', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appid }),
    });
  } catch (err) {
    toast(err.message, true);
  }
}
