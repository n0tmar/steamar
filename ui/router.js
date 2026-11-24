'use strict';

// The hash router: #/home, #/library, #/fixes, #/settings and #/search?q=, plus `?open=` for a game's
// panel. Moving to another view closes the panel, and leaving search empties the field.
// The trap: a route pass that lands on the view already shown is a refresh, not a move, and must
// leave an open panel alone.

/* ---------- router ---------- */

// The view currently on screen. A route pass that lands on the same view is a refresh, not a move,
// so it leaves an open panel and an open search alone.
let shown_tab = '';

function parse_hash() {
  const raw = location.hash.replace(/^#\/?/, '') || 'home';
  const [name, query = ''] = raw.split('?');
  return { name: name || 'home', params: new URLSearchParams(query) };
}

const VIEWS = ['home', 'library', 'fixes', 'settings', 'search'];

async function route() {
  const { name, params } = parse_hash();
  const tab = VIEWS.includes(name) ? name : 'home';
  const moved = tab !== shown_tab;
  const first = !shown_tab;
  shown_tab = tab;

  const titles = {
    home: ['Home', 'Picks from the Steam store'],
    library: ['Library', 'Games you added'],
    fixes: ['Fixes', 'Online fixes for your games'],
    settings: ['Settings', 'Steam and the app'],
    search: ['Search', 'Results from the Steam store'],
  };
  const show = () => {
    document.querySelectorAll('[data-route]').forEach((a) => a.classList.toggle('is-active', a.dataset.route === tab));
    for (const view of VIEWS) $('view-' + view).hidden = view !== tab;
    $('search-show').hidden = tab !== 'search';
    const [title, sub] = titles[tab];
    $('view-title').textContent = title;
    $('view-sub').textContent = sub;
  };
  // Another view crossfades in at the site's pace (motion.css); the first view of a start just appears.
  if (moved && !first && document.startViewTransition) document.startViewTransition(show);
  else show();

  // Moving to another view puts the panel away with it. A pass over the view that is already up must
  // not: a refresh that finishes late used to shut a panel just after it opened.
  if (moved && !$('drawer').hidden) close_drawer();
  // Search remembers where it was started from, and a view that is not search has nothing in the field.
  if (tab !== 'search') {
    search_from = tab;
    if (moved) $('q').value = '';
  }

  if (tab === 'home') render_home();
  else if (tab === 'search') render_search(params.get('q') || '');
  else if (tab === 'library') render_library();
  else if (tab === 'fixes') render_fixes();
  else if (tab === 'settings') {
    if (!state.settings) {
      try { state.settings = await api('/api/settings'); }
      catch (err) { $('view-settings').innerHTML = `<p class="none">${esc(err.message)}</p>`; return; }
    }
    if (!state.setup) await load_setup();
    render_settings();
  }

  const open = params.get('open');
  if (open && $('drawer').hidden) open_drawer(open, {});
}
