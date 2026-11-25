'use strict';

// The Bypass tab: the games the service holds a bypass for, with the words that go with each, and the
// download of one into the person's Downloads folder.
// Trap: the download runs here, not in the page; the page asks how far it got, and a job lives only as
// long as this process.

// One download per game at a time. The file is written beside its final name as .part and renamed
// only once the size the service promised has arrived, so a cut connection never leaves a zip that
// looks finished. The link comes from the service and is good for minutes, so it is asked for on every
// press and never kept.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const child = require('node:child_process');
const api = require('./api');
const vendor = require('./vendor');
const images = require('./images');
const denuvo = require('./denuvo');
const { bad_request, not_found } = require('./errors');

const APPID = /^\d{1,10}$/;
const jobs = new Map(); // appid -> { state: 'downloading' | 'done' | 'failed', percent, file, error }
let known = new Map(); // appid -> the game as the service last listed it

const job = (appid) => jobs.get(String(appid)) || { state: 'idle', percent: 0, file: null, error: null };

async function list() {
  const doc = await api.bypass();
  const games = (Array.isArray(doc && doc.games) ? doc.games : []).filter((g) => APPID.test(String(g.appid)));
  known = new Map(games.map((g) => [String(g.appid), g]));
  return games.map((g) => ({
    ...g,
    appid: String(g.appid),
    image: images.url(g.appid),
    hero: images.hero(g.appid),
    denuvo: denuvo.has(g.appid, g.name),
    job: job(g.appid),
  }));
}

// What Windows refuses in a file name, and a name that ends in a dot or a space.
const file_name = (name) => `${String(name || '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ')
  .trim().replace(/[. ]+$/, '').slice(0, 80) || 'Game'} bypass.zip`;

async function fetch_one(appid, game, row) {
  const link = await api.bypass_link(appid);
  const folder = path.join(os.homedir(), 'Downloads');
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, file_name(game.name));
  const part = `${file}.part`;
  try {
    const { bytes } = await vendor.fetch_file(new URL(link.url, api.base_url()).toString(), part, (got, total) => {
      row.percent = total ? Math.min(99, Math.floor((got / total) * 100)) : 0;
    });
    if (Number(link.size) && bytes !== Number(link.size)) throw new Error('the download stopped before the end - try again');
    fs.renameSync(part, file);
  } finally {
    fs.rmSync(part, { force: true });
  }
  Object.assign(row, { state: 'done', percent: 100, file });
}

function start(appid) {
  const id = String(appid || '');
  if (!APPID.test(id)) throw bad_request('appid must be digits');
  const game = known.get(id);
  if (!game) throw not_found('there is no bypass for this game - open the Bypass tab again');
  const running = jobs.get(id);
  if (running && running.state === 'downloading') return running;
  const row = { state: 'downloading', percent: 0, file: null, error: null };
  jobs.set(id, row);
  fetch_one(id, game, row).catch((err) => Object.assign(row, { state: 'failed', error: err.message }));
  return row;
}

// Explorer takes /select and its path as one argument, quoted its own way; a Windows file name can
// hold no double quote, so the quoting cannot be broken from inside.
function show(appid) {
  const row = job(appid);
  if (row.state !== 'done' || !fs.existsSync(row.file)) throw not_found('the file is not there any more - download it again');
  child.execFile('explorer.exe', [`/select,"${row.file}"`], { windowsVerbatimArguments: true }, () => {});
  return { shown: row.file };
}

module.exports = { list, start, job, show, file_name };
