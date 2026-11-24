'use strict';

// The two views that are shelves of cards: Home (the store's picks, drawn as skeletons until the
// store answers) and Library (what this PC has added). Card markup is in cards.js; the search page
// (search.js) borrows the loading card.
// Trap: Home shows the skeleton until the store answers and an error only after it has failed, and
// render_home() stops and restarts the banner timer each time it draws.

/* ---------- views ---------- */

// The page keeps the shape of what is coming: one block where the banner goes and four cards per
// shelf, at the sizes the real ones take, so nothing moves when the store lands. A card is its
// artwork, its name and its line of small print, in that order.
// Each card starts its highlight 90ms after the one before it, so the shelf reads as a wave.
const sk_card = (i) => `
        <div class="sk-card" style="--sk-delay: ${i * 90}ms">
          <span class="sk sk-art"></span>
          <span class="sk sk-name"></span>
          <span class="sk sk-meta"></span>
        </div>`;

function store_skeleton() {
  const shelf = `
      <section class="shelf">
        <div class="page-head"><span class="sk sk-head"></span></div>
        <div class="grid">${[0, 1, 2, 3].map(sk_card).join('')}</div>
      </section>`;
  return `<span class="sk sk-banner"><span class="sk-hero"></span></span>${shelf}${shelf}`;
}

function render_home() {
  const store = state.store;
  // The shelves are the owner's list of games (src/home.js), in the owner's groups and order.
  stop_banner();

  const shelf = ({ title, games: items }) => (items.length ? `
      <section class="shelf">
        <div class="page-head">
          <h3>${esc(title)}</h3>
          <span class="count">${items.length} games</span>
        </div>
        ${store_grid(items)}
      </section>` : '');

  $('view-home').innerHTML = store
    ? `${banner_html(store.banner)}
       ${(store.shelves || []).map(shelf).join('')}`
    : state.store_error
      ? `<div class="empty">
           <p>The store didn't load</p>
           <p class="hint">Check your internet connection, then try again.</p>
           <p><button class="btn sm" data-act="store-retry">${icon('refresh')}Try again</button></p>
         </div>`
      : store_skeleton();

  const banner = $('banner');
  if (banner) {
    banner_index = 0;
    banner.addEventListener('mouseenter', stop_banner);
    banner.addEventListener('mouseleave', start_banner);
    banner.addEventListener('focusin', stop_banner);
    banner.addEventListener('focusout', start_banner);
    start_banner();
  }
}

function render_library() {
  const list = games().sort(by_name);
  const repair = list.filter((g) => !g.valid).length;
  // Two counts the grid could never carry on its own: what Steam actually has on disk, and what it
  // has been handed a script for but cannot install. A keyless title that is already installed is
  // not counted as broken - the files are there and the tag would be noise.
  const installed = list.filter((g) => g.installed).length;
  const keyless = list.filter((g) => g.keyless && !g.installed).length;

  $('view-library').innerHTML = `
    ${note_bar(`A–Z${installed ? ` · ${installed} installed` : ''}${repair ? ` · ${repair} need${repair === 1 ? 's' : ''} repair` : ''}${keyless ? ` · ${keyless} can't download yet` : ''}`)}
    ${list.length ? grid(list) : `
      <div class="empty">
        <p>No games yet</p>
        <p class="hint">Search the store above to add one.</p>
      </div>`}`;
}
