'use strict';

// The loaders: each asks the engine for one thing (library, status, reach, repair, store), keeps
// the answer in `state`, and redraws only what shows it: the counts, the status bar, Home if it is up.
// A whole view is drawn by the router, not by a loader.
// Trap: loaders call names from later files (render_home, parse_hash), so they run only after boot.

const games = () => state.library.filter((g) => g.kind === 'game');
const by_name = (a, b) => (a.name || a.appid).localeCompare(b.name || b.appid);
const owned_ids = () => new Set(games().map((g) => g.appid));

/* ---------- data ---------- */

async function load_library() {
  const body = await api('/api/library');
  state.library = body.games;
  render_counts();
  render_status();
}

async function load_status() {
  state.status = await api('/api/status');
  render_status();
}

// How many titles can actually be added, counted by the service. A snapshot rather than a live
// query: the engine keeps the last answer and the panel quotes it.
async function load_reach() {
  try {
    state.reach = await api('/api/reach');
    state.reach_error = null;
  } catch (err) {
    // null alone meant "still counting", so a service that never answered left the status bar
    // saying "counting games…" for as long as the page was open. Say which of the two it is.
    state.reach = null;
    state.reach_error = err.message || 'offline';
  }
  render_status();
}

// The checkup is cheap (a few hashes and a folder listing), so it rides along with every refresh:
// the status card has to know about a broken setup before the person clicks anything.
async function load_repair() {
  try {
    state.repair = await api('/api/repair');
  } catch {
    state.repair = null;
  }
}

async function load_store(force = false) {
  if (state.store && !force) return state.store;
  try {
    const body = await api('/api/store');
    state.store = body;
    state.store_error = '';
    if (parse_hash().name === 'home') render_home();
    return body;
  } catch (err) {
    // The skeleton stops being true after a failure: say what happened and offer the one button.
    state.store_error = err.message;
    if (parse_hash().name === 'home') render_home();
    throw err;
  }
}
