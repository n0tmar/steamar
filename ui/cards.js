'use strict';

// The pieces the shelves are built from: a library cover, a store card, the marks a game carries, and
// the rotating banner on Home. Markup only; what goes on a shelf is decided by the views.
// The trap: the banner runs on a timer that only `start_banner()` and `stop_banner()` may touch.

/* ---------- marks ---------- */

// What a game is, as small round marks in the corner of its picture: an icon in the state's colour,
// with its word in the tooltip and for a screen reader. No text over the art, so a cover stays a cover.
const MARKS = {
  owned: ['library', 'own', 'In your library'],
  installed: ['check', 'ok', 'Installed'],
  repair: ['warn', 'warn', 'Needs repair'],
  keyless: ['ban', 'bad', "Can't download yet"],
  unavailable: ['ban', 'bad', 'Not available: SteaMar has nothing to add for it yet'],
  removed: ['archive', 'off', 'Removed from Steam: the store no longer sells it'],
  denuvo: ['shield', 'drm', 'Uses Denuvo'],
};
const marks_html = (names) => (names.length ? `<span class="marks">${names.map((n) => {
  const [glyph, tone, words] = MARKS[n];
  return `<span class="mark ${tone}" role="img" aria-label="${esc(words)}" title="${esc(words)}">${icon(glyph)}</span>`;
}).join('')}</span>` : '');

/* ---------- cards ---------- */

// A library game is its tall cover, the way Steam's own library shows it, with its name and one line
// that says where it stands. The line is the state in words; the marks repeat it at a glance.
function card_html(game, index) {
  const name = game.name || `App ${game.appid}`;
  const state = !game.valid ? ['bad', 'Needs repair']
    : game.installed ? ['ok', 'Installed']
      : game.keyless ? ['bad', "Can't download yet"] : ['', 'Ready to install'];
  const marks = [
    !game.valid && 'repair',
    game.valid && game.installed && 'installed',
    game.valid && game.keyless && !game.installed && 'keyless',
    game.denuvo && 'denuvo',
  ].filter(Boolean);
  const art = game.tall || game.image;
  return `
    <button class="card tall${!game.valid ? ' bad' : ''}" data-appid="${esc(game.appid)}" data-file="${esc(game.file)}"
            data-name="${esc(name)}"${game.denuvo ? ' data-denuvo="1"' : ''} title="${esc(name)}">
      <div class="art${art ? '' : ' noart'}" data-name="${esc(name)}">
        ${art ? `<img src="${esc(art)}" alt="" width="300" height="450" loading="${index < 12 ? 'eager' : 'lazy'}" fetchpriority="${index < 6 ? 'high' : 'auto'}" decoding="async" onerror="this.parentNode.classList.add('noart');this.remove()">` : ''}
        ${marks_html(marks)}
      </div>
      <span class="name">${esc(name)}</span>
      <span class="state${state[0] ? ` ${state[0]}` : ''}"><i></i>${state[1]}</span>
    </button>`;
}

// A card for a game from the store: a shelf on Home, or a search result. A result also carries the
// service's verdict and what other machines reported, so a title that cannot be added, or that failed
// for other people, says so on the card before anyone opens it. A shelf item has neither.
function store_card_html(item, index) {
  const owned = owned_ids().has(item.appid);
  const failed = item.reports && item.reports.fails > 0
    ? `Didn't work for others ${item.reports.fails} of ${item.reports.total} times` : '';
  const marks = [
    owned && 'owned',
    !owned && item.renderable === false && 'unavailable',
    !owned && item.removed && 'removed',
    item.denuvo && 'denuvo',
  ].filter(Boolean);
  return `
    <button class="card" data-appid="${esc(item.appid)}" data-name="${esc(item.name)}"${item.denuvo ? ' data-denuvo="1"' : ''} title="${esc(failed ? `${item.name}: ${failed}` : item.name)}">
      <div class="art${item.image ? '' : ' noart'}" data-name="${esc(item.name)}">
        <img src="${esc(item.image)}" alt="" width="460" height="215" loading="${index < 4 ? 'eager' : 'lazy'}" decoding="async" onerror="this.parentNode.classList.add('noart');this.remove()">
        ${marks_html(marks)}
      </div>
      <span class="name">${esc(item.name)}</span>
      ${failed ? `<span class="meta bad">${esc(failed)}</span>` : ''}
    </button>`;
}

const grid = (list) => `<div class="grid tall">${list.map(card_html).join('')}</div>`;
const store_grid = (list) => `<div class="grid">${list.map((item, i) => store_card_html(item, i)).join('')}</div>`;

/* ---------- denuvo tag, banner ---------- */
// There is no filter any more: the shelves and the library always show everything, and a title
// that uses Denuvo says so on its own card. One state fewer to explain, and nothing can be hidden
// by a chip someone forgot they pressed.

function note_bar(text) {
  return text ? `<div class="filters"><span class="filters-note">${text}</span></div>` : '';
}

let banner_timer = null;
let banner_index = 0;

function banner_html(slides) {
  if (!slides.length) return '';
  // The slides crossfade for everyone, like the site's deck; motion.css drops only the zoom when
  // Windows asks for fewer animations.
  return `
    <section class="banner" id="banner">
      <div class="slides">
        ${slides.map((s, i) => `
          <button class="slide${i === 0 ? ' is-on' : ''}" data-appid="${esc(s.appid)}" data-name="${esc(s.name)}"
                  ${s.denuvo ? 'data-denuvo="1" ' : ''}tabindex="${i === 0 ? '0' : '-1'}" aria-label="${esc(s.name)}">
            <img src="${esc(s.hero)}" alt="" width="1920" height="620"
                 loading="${i === 0 ? 'eager' : 'lazy'}" fetchpriority="${i === 0 ? 'high' : 'low'}" decoding="async"
                 onerror="this.parentNode.classList.add('noart');this.remove()">
            ${s.denuvo ? marks_html(['denuvo']) : ''}
            <span class="slide-text">
              <b>${esc(s.name)}</b>
            </span>
          </button>`).join('')}
      </div>
      <div class="banner-nav">
        <button class="bicon" data-banner="prev" aria-label="Previous banner">${icon('left')}</button>
        <span class="dots">${slides.map((_, i) => `<button class="dot${i === 0 ? ' is-on' : ''}" data-banner="${i}" aria-label="Banner ${i + 1}"></button>`).join('')}</span>
        <button class="bicon" data-banner="next" aria-label="Next banner">${icon('right')}</button>
      </div>
    </section>`;
}

function show_slide(next) {
  const el = $('banner');
  if (!el) return;
  const slides = el.querySelectorAll('.slide');
  if (!slides.length) return;
  banner_index = (next + slides.length) % slides.length;
  slides.forEach((s, i) => {
    s.classList.toggle('is-on', i === banner_index);
    s.tabIndex = i === banner_index ? 0 : -1;
  });
  el.querySelectorAll('.dot').forEach((d, i) => d.classList.toggle('is-on', i === banner_index));
  prefetch_slide(banner_index + 1);
}

function stop_banner() {
  clearInterval(banner_timer);
  banner_timer = null;
}

function start_banner() {
  stop_banner();
  const el = $('banner');
  if (!el || el.querySelectorAll('.slide').length < 2) return;
  banner_timer = setInterval(() => show_slide(banner_index + 1), 6500);
  prefetch_slide(banner_index + 1);
}

// Warm the next slide while the current one is being read, so the swap never
// shows an empty frame on a slow connection.
function prefetch_slide(i) {
  const el = $('banner');
  if (!el) return;
  const slide = el.querySelectorAll('.slide')[i % el.querySelectorAll('.slide').length];
  const img = slide?.querySelector('img');
  if (img && img.loading === 'lazy') img.loading = 'eager';
}
