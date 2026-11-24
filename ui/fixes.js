'use strict';

// The Fixes view: the online release index, searched and filtered, with the state of each fix on
// this disk. Nothing is downloaded or unpacked here; a press opens the host's own page.
// Its click and input listeners are its own, not in events.js.
// Trap: every open asks the engine again, but the list is only redrawn when the answer changed,
// and only the rows while the search box has the caret.

/* ---------- fixes: online releases ---------- */
// Nothing is downloaded or unpacked here. A press finds the one fix file the release points at and
// opens the host's own page, with the archive password ready to copy.

let fixes_data = null;
let fixed_query = '';
let fixq_timer = null;

const FIX_PASSWORD = 'online-fix.me';

// One tag per row, and only when it says something you would act on.
const FIX_TAG = {
  installed: ['ok', 'installed'],
  broken: ['warn', 'incomplete'],
  update: ['warn', 'update'],
  conflict: ['bad', 'conflict'],
  library: ['', ''],
  available: ['', ''],
};

const fix_installed = (r) => Boolean(r.local && r.local.fix);

async function copy_text(text) {
  // The app can copy where the page cannot: WebView2 refuses navigator.clipboard while the window
  // is not focused, and execCommand fails the same way. The engine is an ordinary process in the
  // same session, so it puts the text on the clipboard itself and there is nothing to focus.
  if (bridge) {
    try {
      await api('/api/clipboard', { method: 'POST', body: JSON.stringify({ text }) });
      return true;
    } catch { /* fall through to the page's own ways */ }
  }
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch { /* the async clipboard can be refused; fall through to the old trick */ }
  try {
    const box = document.createElement('textarea');
    box.value = text;
    box.readOnly = true;
    box.style.position = 'fixed';
    box.style.top = '-100px';
    box.style.userSelect = 'text';
    box.style.webkitUserSelect = 'text';
    document.body.appendChild(box);
    box.focus();
    box.select();
    box.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    box.remove();
    return ok;
  } catch {
    return false;
  }
}

// If the clipboard refuses (WebView2 wants a focused window), leave the text selected instead of
// claiming a copy that did not happen: one ctrl+c finishes it.
async function copy_near(button, text) {
  if (await copy_text(text)) {
    toast('Copied');
    return;
  }
  const field = button.closest('.dialog-pass')?.querySelector('input');
  if (field) {
    field.focus();
    field.select();
    toast('Selected. Press Ctrl+C to copy.');
    return;
  }
  toast("Couldn't copy", true);
}

function fix_matches(r) {
  if (!fixed_query) return true;
  const q = fixed_query.toLowerCase();
  return r.title.toLowerCase().includes(q) || String(r.appid || '') === q;
}

function fix_row(r) {
  const [tone, label] = FIX_TAG[r.state] || ['', ''];
  const done = fix_installed(r);
  const version = r.version ? String(r.version).replace(/[.\s]+$/, '') : '';
  const meta = done
    ? r.local.dir.replace(/^.*[\\/]/, '')
    : [
      version ? `v${version}` : '',
      r.last_updated ? `Updated ${r.last_updated}` : (day_label(r.posted_at) ? `Added ${day_label(r.posted_at)}` : ''),
    ].filter(Boolean).join(' · ');
  const alt = r.appid
    ? `/img/hero/${r.appid}.jpg /img/cap/${r.appid}.jpg${r.poster_local ? ` ${r.poster_local}` : ''}`
    : '';
  const cover = r.image || r.poster_local || '';

  return `
    <div class="fixrow" data-fix-row="${esc(String(r.id))}" data-appid="${esc(String(r.appid || ''))}">
      <div class="fixthumb ${cover ? '' : 'noart'}" data-name="${esc(r.title)}">
        ${cover ? `<img src="${esc(cover)}" data-alt="${esc(alt)}" alt="" loading="lazy" decoding="async" onerror="const q=(this.dataset.alt||'').split(' ').filter(Boolean);if(q.length){this.dataset.alt=q.slice(1).join(' ');this.src=q[0];return;}this.parentNode.classList.add('noart');this.remove()">` : ''}
      </div>
      <div class="fixmain">
        <b>${esc(r.title)}</b>
        <span class="fixmeta">${label ? `<span class="tag ${tone}">${label}</span>` : ''}${meta ? `<em>${esc(meta)}</em>` : ''}</span>
      </div>
      <div class="fixside">
        ${done ? `<button class="btn ghost sm icononly" data-target="${esc(r.local.dir)}" data-reveal-fix title="Open the game folder" aria-label="Open the game folder">${icon('folder')}</button>` : ''}
        <button class="btn ghost sm" data-fix-link="${esc(String(r.id))}"
                title="Open the fix file in your browser">${icon('download')}Download</button>
      </div>
    </div>`;
}

// A long shelf draws its first rows with the page and the rest as the end of the list comes near,
// so opening the tab never waits for two thousand rows nobody has scrolled to yet.
const FIX_FIRST = 60;
let fix_tail = [];
let fix_watch = null;

function lazy_rows(rows) {
  if (typeof IntersectionObserver !== 'function' || rows.length <= FIX_FIRST) return rows.map(fix_row).join('');
  fix_tail = rows.slice(FIX_FIRST);
  return `${rows.slice(0, FIX_FIRST).map(fix_row).join('')}<div id="fixtail" aria-hidden="true"></div>`;
}

function watch_tail() {
  if (fix_watch) fix_watch.disconnect();
  const mark = $('fixtail');
  if (!mark || !fix_tail.length || typeof IntersectionObserver !== 'function') return;
  fix_watch = new IntersectionObserver((seen) => {
    if (!seen.some((e) => e.isIntersecting)) return;
    mark.insertAdjacentHTML('beforebegin', fix_tail.splice(0, 120).map(fix_row).join(''));
    // Watching again reports at once, so a marker still in range after the append asks for more.
    fix_watch.unobserve(mark);
    if (fix_tail.length) fix_watch.observe(mark);
    else mark.remove();
  }, { rootMargin: '1200px 0px' });
  fix_watch.observe(mark);
}

// Four shelves at most, and every release appears in exactly one: the ones you already have, what
// people are playing, what went up this week, then everything else newest first.
function fix_body(s) {
  fix_tail = [];
  const shown = s.rows.filter(fix_matches);
  if (!shown.length) return `<div class="empty"><p>No fixes match "${esc(fixed_query)}"</p></div>`;

  const fresh = [...shown].sort((a, b) => String(b.posted_at || '').localeCompare(String(a.posted_at || '')));

  if (fixed_query) {
    const cut = fresh.length > 300 ? `<p class="hint fixmore">${fresh.length - 300} more. Keep typing to narrow it down.</p>` : '';
    return `<div class="group fixgroup"><div class="group-body">${lazy_rows(fresh.slice(0, 300))}${cut}</div></div>`;
  }

  const shelf = (label, rows, draw = (list) => list.map(fix_row).join('')) => `
    <section class="group fixgroup">
      <div class="group-head"><h3>${label}</h3><span class="right">${rows.length}</span></div>
      <div class="group-body">${draw(rows)}</div>
    </section>`;

  const week_ago = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const added_this_week = (r) => {
    const when = Date.parse(r.posted_at || '');
    return Number.isFinite(when) && when > week_ago;
  };
  const taken = new Set();
  const take = (rows) => { for (const r of rows) taken.add(String(r.id)); return rows; };

  const mine = take(fresh.filter((r) => r.in_library || (r.local && r.local.fix)));
  const hot = take(fresh.filter((r) => r.trending && !taken.has(String(r.id))));
  const added = take(fresh.filter((r) => added_this_week(r) && !taken.has(String(r.id))));
  const rest = fresh.filter((r) => !taken.has(String(r.id)));

  return `${mine.length ? shelf('For your games', mine) : ''}`
    + `${hot.length ? shelf('Trending', hot) : ''}`
    + `${added.length ? shelf('Added this week', added) : ''}`
    + `${shelf('All fixes', rest, lazy_rows)}`;
}

function fix_bar(s) {
  const updated = day_label(s.fetched);
  return `
    <div class="filters fixfilters">
      <label class="field fixfind">
        ${icon('search')}
        <input id="fixq" type="search" placeholder="Search ${s.total.toLocaleString()} fixes" aria-label="Search fixes" value="${esc(fixed_query)}" spellcheck="false">
      </label>
      ${updated ? `<span class="filters-note">Updated ${esc(updated)}</span>` : ''}
    </div>`;
}

// What the tab shows changes behind its back: a list that arrived after sign-in, a release added on
// the service, a fix just copied into a game folder. So every open asks the engine; what was read
// last time stays on screen meanwhile and is redrawn only when the answer is different.
const fixes_sig = (s) => (s ? `${s.fetched}|${s.total}|${s.asking ? 1 : 0}|${s.rows.map((r) => `${r.id}:${r.state}`).join(',')}` : '');

// Loading looks like the list it becomes, as Home does: a search field and rows at their real
// height, so nothing moves when the answer lands.
function fixes_skeleton() {
  const row = (i) => `
      <div class="fixrow sk-row" style="--sk-delay: ${i * 70}ms">
        <span class="sk sk-thumb"></span>
        <span class="fixmain"><span class="sk sk-name"></span><span class="sk sk-meta"></span></span>
        <span class="sk sk-btn"></span>
      </div>`;
  return `
    <div class="filters sk-filters"><span class="sk sk-find"></span></div>
    <section class="group fixgroup"><div class="group-body">${[0, 1, 2, 3, 4, 5, 6, 7].map(row).join('')}</div></section>`;
}

async function render_fixes() {
  const view = $('view-fixes');
  if (!fixes_data) view.innerHTML = fixes_skeleton();
  let fresh;
  try {
    fresh = await api('/api/fixes?limit=4000');
  } catch {
    if (!fixes_data) paint_fixes({ total: 0, rows: [] });
    return;
  }
  const changed = fixes_sig(fresh) !== fixes_sig(fixes_data);
  fixes_data = fresh;
  if (changed || !view.querySelector('.fixfilters, .empty')) paint_fixes(fresh);
}

let fixes_retry = null;

function paint_fixes(s) {
  const view = $('view-fixes');
  // The badge starts empty and is filled here: a "0" before the list is read claimed there were none.
  $('c-fixes').textContent = s.total ? String(s.total) : '';

  // Still on its way (a slow first download): keep the skeleton and look again shortly, rather than
  // telling a person on a working connection to check it.
  clearTimeout(fixes_retry);
  if (!s.total && s.asking) {
    if (!view.innerHTML.includes('sk-row')) view.innerHTML = fixes_skeleton();
    fixes_retry = setTimeout(() => { if (shown_tab === 'fixes') render_fixes(); }, 1500);
    return;
  }

  if (!s.total) {
    view.innerHTML = `
      <div class="empty">
        <p>Fixes aren't loaded yet</p>
        <p class="hint">Check your internet connection. This tab tries again each time you open it.</p>
      </div>`;
    return;
  }

  // A person typing while the answer lands keeps the caret: only the rows are redrawn.
  if (document.activeElement && document.activeElement.id === 'fixq' && $('fixbody')) {
    document.activeElement.placeholder = `Search ${s.total.toLocaleString()} fixes`;
    paint_fixbody();
    return;
  }
  view.innerHTML = `${fix_bar(s)}<div id="fixbody">${fix_body(s)}</div>`;
  watch_tail();
}

function paint_fixbody() {
  const el = $('fixbody');
  if (!el || !fixes_data) return;
  el.innerHTML = fix_body(fixes_data);
  watch_tail();
}

// Three lines, the password, and the door out. Nothing else.
function fix_dialog(release, link) {
  if (dialog_answer) close_dialog(false);
  const panel = $('dialog');
  dialog_return_focus = document.activeElement;

  panel.innerHTML = `
    <div class="dialog-panel" role="dialog" aria-modal="true" aria-labelledby="dialog-title">
      <h2 id="dialog-title">${esc(release.title)}</h2>
      <ol class="dialog-steps">
        <li>This opens the fix file in your browser.</li>
        <li>Unpack it with the password below.</li>
        <li>Copy the unpacked files into the game folder.</li>
      </ol>
      <div class="dialog-pass">
        <span>Password</span>
        <input class="dialog-field" readonly value="${FIX_PASSWORD}" spellcheck="false" aria-label="Archive password">
        <button class="btn ghost sm" data-copy-pass="1">Copy</button>
      </div>
      <div class="dialog-foot">
        <button class="btn ghost" data-answer="0">Cancel</button>
        <button class="btn primary" data-answer="1">Download</button>
      </div>
    </div>`;
  panel.hidden = false;
  for (const node of [$('main'), $('setup'), $('drawer')]) if (node) node.inert = true;
  const field = panel.querySelector('.dialog-field');
  if (field) field.select();
  panel.querySelector('[data-answer="1"]')?.focus();
  return new Promise((resolve) => { dialog_answer = resolve; });
}

document.addEventListener('click', async (event) => {
  const reveal = event.target.closest('[data-reveal-fix]');
  if (reveal) {
    await api('/api/reveal', { method: 'POST', body: JSON.stringify({ target: 'path', path: reveal.dataset.target }) }).catch(() => {});
    return;
  }

  const btn = event.target.closest('[data-fix-link]');
  if (!btn) return;
  const id = btn.dataset.fixLink;
  const release = (fixes_data?.rows || []).find((r) => String(r.id) === String(id));
  if (!release) return;

  btn.disabled = true;
  try {
    const { link } = await api(`/api/fixes/link?id=${encodeURIComponent(id)}`);
    if (await fix_dialog(release, link)) {
      await api('/api/open-link', { method: 'POST', body: JSON.stringify({ url: link.url }) })
        .catch(() => toast("Couldn't open your browser", true));
    }
  } catch (err) {
    // A click on Download can fail for two very different reasons, and the difference matters: the
    // release may have no link, or SteaMar may not be reachable at all (nothing was asked). Saying
    // "no link" for an outage would send the person to the wrong conclusion about a release that is fine.
    const offline = ['unreachable', 'no_device', 'not_configured', 'unknown_device'].includes(err.code);
    await open_dialog({
      title: offline ? "Can't reach SteaMar right now" : 'This fix has no download yet',
      message: offline
        ? 'Check your internet connection and try again.'
        : `We couldn't find the download for ${release.title}. Try again later, or ask on Discord.`,
      ok: 'Close',
      tone: 'bad',
    });
  } finally {
    btn.disabled = false;
  }
});

document.addEventListener('input', (event) => {
  if (event.target.id !== 'fixq') return;
  fixed_query = event.target.value.trim();
  // Only the list is repainted, so the field keeps focus and the caret keeps its place.
  clearTimeout(fixq_timer);
  fixq_timer = setTimeout(paint_fixbody, 140);
});
