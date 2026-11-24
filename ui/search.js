'use strict';

// The store search: a page of cards like the library, at #/search?q=, not a list under the field.
// The trap: answers arrive out of order. Each query takes a number from `search_seq` and an answer
// for an older number is dropped.

/* ---------- store search (a page) ---------- */

let search_timer = null;
let search_seq = 0;
// The view a person was on when they started typing: clearing the field takes them back to it.
let search_from = 'home';

// Typing asks for the page. The address holds the query, so Back and a reload keep it; while the page
// is up each letter replaces the address instead of adding to it, so Back leaves search in one step.
function search_for(text) {
  const query = text.trim();
  const on_page = parse_hash().name === 'search';
  if (query.length < 2) {
    if (on_page) location.hash = `#/${search_from}`;
    return;
  }
  const hash = `#/search?q=${encodeURIComponent(query)}`;
  if (!on_page) location.hash = hash;
  else {
    history.replaceState(null, '', hash);
    route();
  }
}

// Two kinds of result a person usually cannot use: a title SteaMar has nothing to add for yet, and a
// title Steam took off its store (it only comes from the service's index). Both are hidden until the
// button left of the search field is on. The switches start off with every window and are not saved,
// and the page always says how many it hid, so nothing goes missing without a word.
const search_show = { unavailable: false, removed: false };
const kind_of = (r) => (r.renderable === false ? 'unavailable' : r.removed ? 'removed' : '');

function paint_search_show() {
  for (const button of document.querySelectorAll('[data-search-show]')) {
    button.setAttribute('aria-pressed', String(search_show[button.dataset.searchShow]));
  }
}

function search_html(query, results) {
  if (!results.length) {
    return `
      <div class="empty">
        <p>No results for “${esc(query)}”</p>
        <p class="hint">Check the spelling, or try fewer words.</p>
      </div>`;
  }
  // A game already in the library is never hidden: it is the person's own.
  const owned = owned_ids();
  const shown = results.filter((r) => owned.has(r.appid) || !kind_of(r) || search_show[kind_of(r)]);
  const hidden = results.length - shown.length;
  const note = `${shown.length} result${shown.length === 1 ? '' : 's'} for “${esc(query)}”${hidden ? ` · ${hidden} hidden, the buttons left of the search show them` : ''}`;
  if (!shown.length) {
    return `
      <div class="empty">
        <p>Nothing you can add for “${esc(query)}”</p>
        <p class="hint">${hidden} result${hidden === 1 ? ' is' : 's are'} hidden. The buttons left of the search field show ${hidden === 1 ? 'it' : 'them'}.</p>
      </div>`;
  }
  return `
    ${note_bar(note)}
    <div class="grid">${shown.map((r, i) => store_card_html(r, i)).join('')}</div>`;
}

// A switch redraws the answer already on the page; it asks the store nothing.
function toggle_search_show(kind) {
  search_show[kind] = !search_show[kind];
  paint_search_show();
  const query = parse_hash().params.get('q') || '';
  if (parse_hash().name === 'search' && state.results && query.trim().length >= 2) {
    $('view-search').innerHTML = search_html(query.trim(), state.results);
  }
}

async function render_search(text) {
  const view = $('view-search');
  const query = text.trim();
  // A reload or Back arrives with the query in the address and an empty field. A person typing is left
  // alone: their next letter is already on its way here.
  if (document.activeElement !== $('q') && $('q').value.trim() !== query) $('q').value = query;
  if (query.length < 2) {
    view.innerHTML = '<div class="empty"><p>Type a game\'s name to search the Steam store.</p></div>';
    return;
  }

  const seq = ++search_seq;
  // Results already on the page stay there, dimmed, while the next letter is asked about, so typing
  // does not blink the page away and back. Only an empty page shows the loading cards.
  if (!view.querySelector('.card')) {
    view.innerHTML = `<div class="filters"><span class="sk sk-head"></span></div>
      <div class="grid">${[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(sk_card).join('')}</div>`;
  }
  view.classList.add('is-asking');

  try {
    const body = await api(`/api/search?q=${encodeURIComponent(query)}`);
    if (seq !== search_seq) return; // a later keystroke already won
    state.results = body.results;
    view.innerHTML = search_html(query, body.results);
  } catch (err) {
    if (seq !== search_seq) return;
    view.innerHTML = `
      <div class="empty">
        <p>${err.code === 'unreachable' ? "Can't connect right now" : "Search didn't work"}</p>
        <p class="hint">${err.code === 'unreachable' ? 'Check your internet connection, then press Enter to try again.' : 'Press Enter to try again in a moment.'}</p>
      </div>`;
  } finally {
    if (seq === search_seq) view.classList.remove('is-asking');
  }
}
