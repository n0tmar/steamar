'use strict';

// The window for one game, over the middle of the page: its picture and name, whether it can be
// added, what other machines reported, the buttons, and what the store says about it. No prices,
// here or anywhere. It was a panel at the side once, which is why the code still calls it the drawer.
// The trap: `undefined` means still asking the store and `null` means the store has nothing for
// this id; they are drawn differently.

/* ---------- drawer ---------- */

// What the store says about a game: one sentence it wrote, then the facts a person checks before
// adding something. No prices, here or anywhere else in the app. `undefined` means still asking,
// `null` means the store has nothing to say about this id, which is a drawer with buttons only.
// Free is not a fact here: the panel says it once, in the state line, and nowhere else.
function about_body(d) {
  if (d === undefined) {
    return `<span class="sk" style="width:100%;height:11px"></span>
        <span class="sk" style="width:72%;height:11px;margin-top:7px"></span>`;
  }
  if (!d || d.missing) return '';

  const fact = (label, value, cls = '') => `<span class="dfact${cls}"><i>${label}</i><b>${esc(value)}</b></span>`;
  const facts = [];
  if (d.release) facts.push(fact(d.coming_soon ? 'coming' : 'released', d.release));
  if (d.developers && d.developers.length) facts.push(fact('by', d.developers.join(', ')));
  if (d.genres && d.genres.length) facts.push(fact('genre', d.genres.join(', ')));
  if (d.players && d.players.length) facts.push(fact('players', d.players.join(', ')));

  if (!d.description && !facts.length) return '';
  return `${d.description ? `<p class="ddesc">${esc(d.description)}</p>` : ''}${
    facts.length ? `<div class="dfacts">${facts.join('')}</div>` : ''}`;
}

// Where focus came from, so closing the panel puts it back on the card that opened it.
let drawer_back = null;

function close_drawer() {
  const drawer = $('drawer');
  const was_open = !drawer.hidden;
  drawer.hidden = true;
  if ($('setup').hidden) $('scrim').hidden = true;
  $('main').inert = false;
  if (was_open && drawer_back && document.contains(drawer_back)) drawer_back.focus();
  drawer_back = null;
}

// The cover arrives with the details when the caller had no art to hand, so it is put into the
// picture rather than repainting the window and losing the buttons under the pointer.
function fill_cover(drawer, src) {
  if (!src || drawer.querySelector('.cover')) return;
  drawer.querySelector('.dhero')?.insertAdjacentHTML('afterbegin',
    `<img class="cover" src="${esc(src)}" alt="" width="460" height="215" decoding="async" onerror="this.remove()">`);
}

// Steam's wide library picture goes over the cover once the details name it, and fades in as it
// lands (motion.css). A game without one keeps its cover; one opened from the banner has it already.
function paint_hero(drawer, appid, src = state.details[appid]?.hero) {
  const box = drawer.querySelector('.dhero');
  if (!src || !box || box.querySelector('img[src*="/img/hero/"]')) return;
  const html = `<img class="hero" src="${esc(src)}" alt="" width="1920" height="620" decoding="async" onerror="this.remove()">`;
  const cover = box.querySelector('.cover');
  if (cover) cover.insertAdjacentHTML('afterend', html);
  else box.insertAdjacentHTML('afterbegin', html);
}

function drawer_body(game, appid, info = {}) {
  const free = Boolean(info.free);
  // What other machines hit on this title, if anybody told the service. One line, at the bottom.
  const report = (info.verdict && info.verdict.reports) || null;
  if (!game) {
    // A game that costs nothing needs no help, so the panel says so instead of offering a script.
    // The add button stays in the row, dimmed and still reachable by keyboard, because a missing
    // button reads as a bug while a dimmed one with a reason reads as a decision.
    if (free) {
      // The store says "free" for three different things: a game that lives on donations, a demo,
      // and something that has not shipped yet. Each needs its own sentence and its own button.
      const kind = info.demo ? 'demo' : info.soon ? 'soon' : 'free';
      const words = {
        demo: {
          state: 'A free demo on Steam.',
          label: 'Get it on Steam',
          act: `data-install="${esc(appid)}"`,
          tip: 'Demos are free on Steam, so there is nothing to add.',
          hint: 'Demos are free. Get it straight from Steam.',
          toast: 'This is a free demo. Get it from Steam.',
        },
        soon: {
          state: 'Not out yet.',
          label: 'Open the store page',
          act: `data-store="${esc(appid)}"`,
          tip: 'This game is not out yet, so there is nothing to add.',
          hint: 'Wishlist it on Steam and you will get a note on release day.',
          toast: 'Not out yet. You can wishlist it on Steam.',
        },
        free: {
          state: 'Free on Steam.',
          label: 'Get it on Steam',
          act: `data-install="${esc(appid)}"`,
          tip: 'This game is free on Steam, so there is nothing to add.',
          hint: 'You do not need SteaMar for this one. Get it straight from Steam.',
          toast: 'This game is free. Get it from Steam.',
        },
      }[kind];
      return `
      <p class="dstate free">${words.state}</p>
      <div class="actions">
        <button class="btn primary wide" ${words.act}>${icon('download')}${words.label}</button>
        <button class="btn ghost" aria-disabled="true" data-free-blocked="${esc(words.toast)}" title="${esc(words.tip)}">${icon('plus')}Add to library</button>
      </div>
      <p class="hint">${esc(words.hint)}</p>`;
    }
    const verdict = info.verdict || null;
    if (verdict && verdict.renderable === false) {
      // A title SteaMar cannot add says so before the click instead of after it. The button stays
      // visible and dimmed: a missing button reads as a bug, a dimmed one with a reason as a decision.
      // The service's own reason is for the owner's logs, not for this panel.
      return `
      <p class="dstate bad">Can't be added yet.</p>
      <div class="actions">
        <button class="btn primary wide" aria-disabled="true" title="SteaMar can't add this game yet">${icon('plus')}Add to library</button>
      </div>
      <p class="hint">SteaMar doesn't have what Steam needs for this game yet. Check back later.</p>${report_note(report)}`;
    }
    return `
      <p class="dstate">${info.removed ? 'Removed from the Steam store. You can still add it.' : 'Not in your library yet.'}</p>
      <div class="actions">
        <button class="btn primary wide" data-add="${esc(appid)}">${icon('plus')}Add to library</button>
        <button class="btn ghost wide" data-add="${esc(appid)}" data-install-after="1">${icon('download')}Add &amp; install</button>
      </div>
      <p class="hint">Add puts the game in your Steam library. Add &amp; install also starts the download.</p>${report_note(report)}`;
  }
  if (!game.valid) {
    return `
      <p class="dstate bad">This game needs a repair.</p>
      <div class="actions">
        <button class="btn primary wide" data-add="${esc(appid)}" data-file="${esc(game.file)}">${icon('refresh')}Repair</button>
        <button class="btn ghost" data-remove="${esc(game.file)}">${icon('trash')}Remove</button>
      </div>
      <p class="hint">Steam can't read this game's entry. Repair writes it again; Remove takes it out of your library.</p>`;
  }
  return `
    <p class="dstate">In your library.</p>
    <div class="actions">
      <button class="btn primary wide" data-install="${esc(game.appid)}">${icon('download')}Install</button>
      <button class="btn ghost" data-remove="${esc(game.file)}">${icon('trash')}Remove</button>
    </div>
    ${free ? '<p class="hint">This game is free on Steam anyway.</p>' : ''}${report_note(report)}`;
}

// The body is drawn with what is known and drawn again once if the store turns out to say this one
// is free. Only the body is replaced, so the title, the cover and anything the person just read stay
// where they were.
function paint_body(drawer, local, appid) {
  const body = drawer.querySelector('.dbody');
  if (!body) return;
  const d = state.details[appid];
  // A game taken off the Steam store cannot be got there, free or not: it is offered like any other.
  const row = (state.results || []).find((r) => String(r.appid) === String(appid));
  const removed = Boolean((d && d.removed) || (row && row.removed));
  const free = Boolean(d && d.free) && !removed;
  // is_free covers more than free games: demos and unreleased free titles answer true as well, and
  // they need different words. The verdict and the reason are one signature.
  const kind = !free ? 'paid' : d.type === 'demo' ? 'demo' : d.coming_soon ? 'soon' : 'free';
  // Still asking, answered, and answered with nothing are three different pictures.
  const verdict = verdict_of(appid);
  // The pre-flight can arrive after the panel did, so it is part of the signature: a body drawn
  // before the verdict and one drawn after are not the same body.
  const vkey = verdict
    ? `${verdict.renderable ? 'y' : 'n'}${verdict.partial ? 'p' : ''}${verdict.reports ? `:${verdict.reports.total}/${verdict.reports.fails}` : ''}`
    : 'x';
  const sig = `${kind}${removed ? '-gone' : ''}:${d === undefined ? 'asking' : d ? 'known' : 'none'}:${vkey}`;
  if (body.dataset.sig === sig) return;
  body.dataset.sig = sig;
  const about = about_body(d);
  body.innerHTML = `${drawer_body(local, appid, {
    free,
    demo: kind === 'demo',
    soon: kind === 'soon',
    removed,
    verdict,
  })}${about.trim() ? `<div class="dabout">${about}</div>` : ''}`;
}

// What the search already learned about this id, so the panel says the same thing the card said: a
// title with no keys installs nothing, and offering Add for it is the complaint this closes. The
// one-title verdict fetched when the panel opens wins, because a panel can be opened from the
// library or a deep link, where no search row exists.
function verdict_of(appid) {
  const live = state.verdicts[String(appid)];
  const row = live || (state.results || []).find((r) => String(r.appid) === String(appid));
  if (!row || row.renderable === undefined) return null;
  const seen = row.reports || row.report || null;
  return {
    renderable: row.renderable !== false,
    partial: Boolean(row.partial),
    reason: row.reason || null,
    reports: seen && Number(seen.total) > 0
      ? { total: Number(seen.total) || 0, fails: Number(seen.fails) || 0, last_outcome: seen.last_outcome || null, last_at: seen.last_at || null }
      : null,
  };
}

// A time a person reads without arithmetic. Older than a week is a date.
function ago(stamp) {
  const at = Date.parse(stamp);
  if (!Number.isFinite(at)) return '';
  const secs = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (secs < 90) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 36) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
  const days = Math.round(hours / 24);
  if (days < 8) return `${days} ${days === 1 ? 'day' : 'days'} ago`;
  return new Date(at).toLocaleDateString();
}

// What other machines hit on this title, in one line. A count is the only honest way to say "this
// works for other people" or "it did not", and it is drawn under the buttons so it reads as advice
// rather than as a warning about the thing being offered.
function report_note(report) {
  if (!report || !report.total) return '';
  const total = Number(report.total) || 0;
  const fails = Number(report.fails) || 0;
  if (!fails) {
    return `<p class="hint rep">Added ${total === 1 ? 'once' : `${total} times`} by other people, with no problems.</p>`;
  }
  return `<p class="hint rep bad">Didn't work for other people ${fails} of ${total} times.</p>`;
}

// The card that was pressed already has the art in it, at an address the shell can load, so the
// drawer borrows that instead of building a path of its own. Search rows carry the small capsule,
// which would stretch to a blur at panel width, so those wait for the full art from the details call.
const art_of = (el) => {
  const img = el.querySelector('img');
  return img && img.naturalWidth >= 400 ? img.currentSrc || img.src : '';
};

// The chip a card carries follows the game into the panel, and every source that already knows the
// answer feeds it: the library record, the row that was pressed, or the details call. First one wins.
function paint_denuvo(drawer, on) {
  const box = drawer.querySelector('.dchips');
  if (!box) return;
  if (on === Boolean(box.firstChild)) return;
  // In the window there is room for the word, so the mark becomes a chip: its icon and its name.
  box.innerHTML = on ? `<span class="chip drm">${icon('shield')}Uses Denuvo</span>` : '';
}

// The window up, over a scrim, with the page behind out of reach the same way a dialog handles it, so a
// keyboard cannot wander into the grid under it. `shows` names what is in it: an answer that lands
// after the window moved on to something else must not paint into it.
function show_drawer(shows) {
  const drawer = $('drawer');
  drawer.hidden = false;
  drawer.dataset.shows = shows;
  $('scrim').hidden = false;
  $('main').inert = true;
  drawer_back = document.activeElement && document.activeElement !== document.body ? document.activeElement : null;
  return drawer;
}

// The picture, with the name over its foot and the way out in its corner; then the body, which is the
// only part that scrolls, so the name and the way out never leave the window.
const drawer_frame = (cover, title) => `
      <div class="dhero">
        ${cover ? `<img class="cover" src="${esc(cover)}" alt="" width="460" height="215" decoding="async" onerror="this.remove()">` : ''}
        <div class="dhead">
          <h2 id="drawer-title">${esc(title || 'Loading…')}</h2>
          <div class="dchips" data-dchips></div>
        </div>
        <button class="dclose" data-close aria-label="Close">${icon('close')}</button>
      </div>
      <div class="dbody"></div>`;

async function open_drawer(appid, meta = {}) {
  const shows = `game:${appid}`;
  const drawer = show_drawer(shows);
  const gone = () => drawer.hidden || drawer.dataset.shows !== shows;

  const local = state.library.find((g) => (meta.file && g.file === meta.file) || g.appid === appid) || null;
  const name = meta.name || local?.name || '';
  // A bare /img/ path resolves to the shell's virtual host, which serves nothing, so the cover has
  // to come from somewhere that already carries an address: the card that was pressed, the library
  // record, or the details call below.
  const cover_of = () => meta.image || local?.image || state.details[appid]?.image || '';
  // Denuvo is not something the store answers: it comes from the app's own list, matched by id or by
  // name. Whatever already knows it says so first, and the details call settles it if nothing did.
  const denuvo_here = () => Boolean(meta.denuvo || local?.denuvo || state.details[appid]?.denuvo);

  const paint = (title) => {
    drawer.innerHTML = drawer_frame(cover_of(), title);
    paint_body(drawer, local, appid);
    paint_denuvo(drawer, denuvo_here());
    paint_hero(drawer, appid);
  };

  paint(name);
  drawer.focus();
  // A reader hears "busy" until the store answers, then the text simply arrives.
  drawer.setAttribute('aria-busy', state.details[appid] === undefined ? 'true' : 'false');

  // Only reach for the name when the caller had none (deep link, bare appid).
  if (!name) {
    try {
      const body = await api(`/api/names?ids=${appid}`);
      if (gone()) return;
      paint(body[appid]?.name || `app ${appid}`);
    } catch { /* keep the placeholder title */ }
  }

  // The description is a second call, so the buttons work before it lands. A miss leaves the
  // drawer as it was: this is the one part of the panel that is a bonus, not a promise.
  // The pre-flight for this one title, asked as the panel opens: a panel opened from the library,
  // the fixes list or a deep link has no search row to borrow an answer from. A service that does
  // not answer costs the sentence under the buttons, never the panel.
  if (!(appid in state.verdicts)) {
    api(`/api/verdict?appid=${encodeURIComponent(appid)}`)
      .then((v) => {
        state.verdicts[appid] = v || null;
        if (gone()) return;
        paint_body(drawer, local, appid);
      })
      .catch(() => { state.verdicts[appid] = null; });
  }
  if (!(appid in state.details)) {
    api(`/api/app?appid=${encodeURIComponent(appid)}`)
      .then((d) => {
        state.details[appid] = d && d.missing ? null : d;
        if (gone()) return;
        fill_cover(drawer, state.details[appid]?.image);
        paint_hero(drawer, appid);
        paint_body(drawer, local, appid);
        paint_denuvo(drawer, denuvo_here());
        drawer.setAttribute('aria-busy', 'false');
      })
      .catch(() => {
        state.details[appid] = null;
        if (!gone()) {
          paint_body(drawer, local, appid);
          drawer.setAttribute('aria-busy', 'false');
        }
      });
  }
}
