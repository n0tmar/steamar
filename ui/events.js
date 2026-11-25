'use strict';

// The listeners, attached once to the document and the window: clicks are delegated by
// `closest()`, so a view that redraws its buttons keeps working without attaching anything again.
// The Fixes rows are not handled here; fixes.js attaches its own listeners.
// Trap: the click handler returns at the first match, and [data-act] is checked before [data-add],
// [data-store] and the cards.

/* ---------- events ---------- */

document.addEventListener('click', (e) => {
  const nav = e.target.closest('[data-banner]');
  if (nav) {
    e.preventDefault();
    const to = nav.dataset.banner;
    show_slide(to === 'prev' ? banner_index - 1 : to === 'next' ? banner_index + 1 : Number(to));
    start_banner();
    return;
  }

  const slide = e.target.closest('.slide[data-appid]');
  if (slide) return open_drawer(slide.dataset.appid, { name: slide.dataset.name, image: art_of(slide), denuvo: slide.dataset.denuvo === '1' });

  if (e.target.closest('[data-close-setup]')) return close_setup();

  const pick = e.target.closest('[data-pick]');
  if (pick) return choose_folder(pick.dataset.pick);

  const pick_reset = e.target.closest('[data-pick-reset]');
  if (pick_reset) {
    const key = pick_reset.dataset.pickReset;
    return save_path(key, '');
  }

  const show = e.target.closest('[data-search-show]');
  if (show) return toggle_search_show(show.dataset.searchShow);

  const act = e.target.closest('[data-act]');
  if (act && act.tagName !== 'FORM') { e.preventDefault(); handle_act(act); return; }

  if (e.target.closest('[data-close]')) return close_drawer();

  const add = e.target.closest('[data-add]');
  if (add) return add_app(add.dataset.add, add.dataset.file, add.dataset.installAfter === '1');

  // The add button on a free game is dimmed rather than gone. Pressing it explains itself instead of
  // doing nothing, which is what a dead control usually means.
  const blocked = e.target.closest('[data-free-blocked]');
  // The button carries its own sentence (drawer.js), so the words live in one place.
  if (blocked) return toast(blocked.dataset.freeBlocked);

  const store = e.target.closest('[data-store]');
  if (store) return open_store(store.dataset.store);

  const install = e.target.closest('[data-install]');
  if (install) return install_app(install.dataset.install);

  const remove = e.target.closest('[data-remove]');
  if (remove) return remove_app(remove.dataset.remove);

  const bypass = e.target.closest('.card[data-bypass]');
  if (bypass) return open_bypass(bypass.dataset.bypass);

  const card = e.target.closest('.card[data-appid]');
  if (card) return open_drawer(card.dataset.appid, { file: card.dataset.file, name: card.dataset.name, image: art_of(card), denuvo: card.dataset.denuvo === '1' });
});

$('q').addEventListener('input', (e) => {
  const q = e.target.value;
  clearTimeout(search_timer);
  search_timer = setTimeout(() => search_for(q), 220);
});

$('q').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    clearTimeout(search_timer);
    search_for(e.target.value);
  }
  // Escape empties the field, which takes the page back to where the search started; an empty
  // field lets go of the focus instead.
  if (e.key === 'Escape') {
    clearTimeout(search_timer);
    if (e.target.value) { e.target.value = ''; search_for(''); }
    else e.target.blur();
  }
});

// The library is the source of truth for "in library", and a script can be dropped or removed
// outside this window (drop.js, another copy). It is read again before the results paint a tag.
$('q').addEventListener('focus', () => { load_library().catch(() => {}); });

$('scrim').addEventListener('click', () => {
  if (!$('setup').hidden) close_setup();
  else close_drawer();
});

document.addEventListener('keydown', (e) => {
  const tag = document.activeElement?.tagName;
  // The search field is behind the panel while it is up, so "/" would move focus nowhere. It waits.
  const typing = tag === 'INPUT' || tag === 'TEXTAREA';
  if (e.key === '/' && !typing && $('setup').hidden && $('drawer').hidden) { e.preventDefault(); $('q').focus(); return; }
  if (e.key === 'Escape') {
    if (!$('setup').hidden) close_setup();
    else if (!$('drawer').hidden) close_drawer();
  }
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) return stop_banner();
  if (parse_hash().name === 'home') start_banner();
  on_return();
});

// Back in the window: a donation or a new role may have landed meanwhile (account.js, on_return).
window.addEventListener('focus', () => on_return());

window.addEventListener('hashchange', route);

// A picture fades in when it arrives instead of popping in (motion.css). Load does not bubble, so one
// listener on the document catches every picture on the way down.
document.addEventListener('load', (e) => {
  if (e.target && e.target.tagName === 'IMG') e.target.classList.add('is-in');
}, true);
