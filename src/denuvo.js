'use strict';

// The Denuvo title list from the service, held in memory and matched by app id or normalized name.
// It never fetches per lookup; hydrate() replaces the whole list.
// Trap: before the first hydrate() answers, has() and match() return false for every title.

// Steam does not expose DRM through its API, so the list of Denuvo titles is kept by the service and
// handed over whole: one document of { name, appid } pairs, once an hour.
//
// A title is matched two ways. By name, after normalization (case, punctuation, accents, "the"),
// which covers everything the store shows. And by app id, which the service resolved for us — that is
// what keeps a game tagged when its display name carries a subtitle ("RAIDOU Remastered: The Mystery
// of the Soulless Army") or when a library row only has an id.

const api = require('./api');

// "Assassin's Creed: Black Flag Resynced" and "assassins creed black flag resynced" are the same
// game, and so are "Yakuza Kiwami 3 & Dark Ties" and "yakuza kiwami 3 dark ties".
function normalize(name) {
  return String(name || '')
    // Before NFKD, which decomposes ™ into "TM": by then it is part of a word.
    .replace(/[™®©]/gu, ' ')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

let cache = { titles: [], keys: new Set(), appids: new Set(), fetched: null, loaded_at: 0 };

// Matching has to be instant - a card, a search row and a library tile all ask - so the list is held
// in memory and refreshed in the background. Before the first answer every chip is simply off.
// One question at a time: boot and a sign-in can both ask for it at once.
let asking = null;
function hydrate() {
  if (!asking) asking = fill().finally(() => { asking = null; });
  return asking;
}

async function fill() {
  const doc = await api.denuvo();
  const titles = [];
  const keys = new Set();
  const appids = new Set();
  for (const row of doc?.titles || []) {
    const name = String(row.name || '').trim();
    if (!name) continue;
    titles.push(name);
    keys.add(normalize(name));
    if (row.appid) appids.add(String(row.appid));
  }
  cache = { titles, keys, appids, fetched: doc?.fetched || null, loaded_at: Date.now() };
  return stats();
}

// `name` is what the UI will show, so a card, a search row and a library tile all agree.
function has(appid, name) {
  if (appid && cache.appids.has(String(appid))) return true;
  const key = normalize(name);
  return Boolean(key) && cache.keys.has(key);
}

const match = (name) => has(null, name);

const stats = () => ({
  count: cache.titles.length,
  resolved: cache.appids.size,
  fetched: cache.fetched,
  loaded_at: cache.loaded_at || null,
  source: 'service',
});

module.exports = { has, match, stats, hydrate, load: () => cache, normalize };
