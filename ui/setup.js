'use strict';

// The first-run setup: where Steam is, the helper files, the data download and the self-check, and
// the folder picker. The download runs in the engine; this panel only polls /api/setup.
// Trap: one timer, `setup_timer`, watches a download and is cleared when it ends; start it only
// through watch_setup().

/* ---------- first-run setup ---------- */

// One artwork everywhere: the same file the exe carries as its icon.
const MARK = '<img src="/logo.png" alt="" width="30" height="30" decoding="async">';

async function load_setup() {
  try { state.setup = await api('/api/setup'); }
  catch { state.setup = null; }
  return state.setup;
}

function render_setup() {
  const s = state.setup;
  const panel = $('setup');
  if (!s) return;

  const found = s.source?.files?.length || 0;
  const total = s.dlls.length;
  const ready = s.ready;

  // What SteaMar keeps beside itself: the three helper files. Those are fetched by the app, so a
  // fresh copy on a new PC only has to press one button. The game list is not a file any more: it
  // comes from the service, so `local.data.ready` is true with nothing on disk.
  const local = s.vendor || { ready: false, files: [], data: { ready: false, files: [] }, download: { active: false } };
  const dl = local.download || { active: false, label: '', bytes: 0, total: 0, error: '' };
  const has_helpers = Boolean(local.ready) || found > 0;
  const has_data = Boolean(local.data && local.data.ready);
  // The game list is live: an old copy still works, but it cannot hand out games added since.
  const data_stale = Boolean(local.data && local.data.stale);
  const percent = dl.total ? Math.min(100, Math.round((dl.bytes / dl.total) * 100)) : 0;
  const missing = [!local.ready && 'the helper files', !has_data && 'the game list'].filter(Boolean).join(' and ');
  const ready_line = [local.ready && `Helper files${local.version ? ` ${esc(local.version)}` : ''}`, has_data && 'game list'].filter(Boolean).join(' and ') + (local.ready || has_data ? ' ready' : '');

  // A bad or old Steam setup is a step of the setup, not a settings group: one sentence, one
  // button, and the steps carry on from where they were. No file names, sizes or hashes — the
  // person pressed fix, not "explain my registry to me". The same check runs every launch, so a
  // folder that goes bad months later brings the step back and sets itself up again.
  const rep = state.repair;
  // Before the first setup, a missing helper file, config, folder or game list is the next step, not
  // something an older setup left behind: a new PC was told "repair first". Only a leftover counts then.
  const setup_step = (f) => /^(dll-missing:|toml-missing$|folder:|data-missing$)/.test(f.id);
  const repair_needed = Boolean(rep && rep.findings.some((f) => f.fixable && (ready || !setup_step(f))));
  const repairing = Boolean(state.repairing);
  const repair_line = rep && rep.steam_running
    ? ready
      ? 'Something from an older setup is in the way. Steam closes, SteaMar fixes it, and Steam opens again.'
      : 'Something from an older setup is in the way. Steam closes, SteaMar fixes it, and the setup carries on.'
    : 'Something from an older setup is in the way. SteaMar puts it aside, and your games stay.';
  const setup_title = repair_needed
    ? 'Steam needs a repair first'
    : ready
      ? 'SteaMar is set up'
      : 'Let’s get SteaMar working';
  const setup_intro = repair_needed
    ? 'An older setup left something behind. One press fixes it.'
    : ready
      ? 'Steam has the files it needs. Any game you add shows up in your library.'
      : 'Steam needs three small files. SteaMar downloads them for you.';

  const repair_step = !repair_needed ? '' : `
          <div class="sstep">
            <span class="n">1</span>
            <div class="sstep-text">
              <b>Repair first</b>
              <em>${esc(repair_line)}</em>
            </div>
            <button class="btn primary" data-act="repair-now"${repairing ? ' disabled' : ''}>${icon('check')}${repairing ? 'Fixing…' : 'Fix it'}</button>
          </div>`;
  const step_no = (n) => n + (repair_needed ? 1 : 0);

  panel.innerHTML = `
    <div class="setup-panel" role="dialog" aria-modal="true" aria-labelledby="setup-title">
      <div class="setup-head">
        <span class="mark" aria-hidden="true">${MARK}</span>
        <div class="setup-title">
          <h2 id="setup-title">${setup_title}</h2>
          <p>${setup_intro}</p>
        </div>
        <button class="icon close" data-close-setup aria-label="Close">${icon('close')}</button>
      </div>

      ${ready && !repair_needed ? `
        <div class="setup-done">
          <p><b>${s.dlls.filter((d) => d.present).length} of ${s.dlls.length}</b> helper files are in your Steam folder.</p>
          <p class="hint">You can remove them any time from Settings. Your added games stay.</p>
        </div>` : `
        <div class="ssteps">
          ${repair_step}
          ${ready ? '' : `
          <div class="sstep">
            <span class="n">${step_no(1)}</span>
            <div class="sstep-text"><b>Steam folder</b><em title="${esc(s.steam_root)}">${esc(s.steam_root)}</em></div>
            <button class="btn ghost" data-pick="steam_root">${icon('folder')}Change</button>
          </div>
          <div class="sstep">
            <span class="n">${step_no(2)}</span>
            <div class="sstep-text">
              <b>Files SteaMar needs</b>
              <em class="${dl.error ? 'err' : ''}">${dl.active
                ? `${esc(dl.label)}${dl.total ? ` · ${percent}%` : ''}`
                : dl.error
                  ? esc(dl.error)
                  : missing
                    ? `SteaMar downloads ${missing} for you`
                    : data_stale
                      ? `${ready_line}. Press Update for the newest games.`
                      : ready_line}</em>
              ${dl.active ? `<div class="sbar"><i style="width:${percent}%"></i></div>` : ''}
            </div>
            ${dl.active
              ? `<button class="btn ghost" disabled>${icon('download')}${percent}%</button>`
              : !has_helpers || !has_data || data_stale
                ? `<div class="sizes">
                     <button class="btn" data-act="setup-fetch"${has_data && data_stale ? ' data-force="1"' : ''}>${icon('download')}${has_data ? 'Update' : 'Download'}</button>
                     ${local.ready ? '' : `<button class="btn ghost" data-pick="dll_source" title="Use files you already have">${icon('folder')}Folder</button>`}
                   </div>`
                : `<button class="btn ghost" data-act="setup-fetch" title="Check again">${icon('refresh')}Check</button>`}
          </div>
          <div class="sstep">
            <span class="n">${step_no(3)}</span>
            <div class="sstep-text">
              <b>Leave Steam closed, then set up</b>
              <em class="${state.setup_error ? 'err' : ''}">${state.setup_error
                ? esc(state.setup_error)
                : s.steam_running ? 'Steam is running. Close it first.' : has_helpers ? 'Steam is closed. Good to go.' : 'Needs the files from step 2 first.'}</em>
            </div>
            <button class="btn primary" data-act="setup-install" ${has_helpers ? '' : 'disabled'}>${icon('download')}Set up</button>
          </div>`}
        </div>`}

      <div class="setup-foot">
        <span class="hint">${ready && !repair_needed
          ? 'You can open this again from Settings.'
          : `Stuck? <a class="link" href="${COMMUNITY}" target="_blank" rel="noreferrer noopener">Ask on Discord</a>`}</span>
        <button class="btn ghost sm" data-act="selftest" title="See if anything is wrong">${selfcheck_mark()}Check my setup</button>
        <button class="btn ghost" data-close-setup>${ready && !repair_needed ? 'Close' : 'Later'}</button>
      </div>
    </div>`;
}

function open_setup() {
  render_setup();
  $('setup').hidden = false;
  $('scrim').hidden = false;
  // The check runs once when the sheet opens, so its button can stay plain text while everything
  // is fine and only grow a warning mark when something is really wrong.
  load_selftest().then(paint_selftest_button);
}

// The mark on the check button: nothing when the setup is healthy, a small warning when it is not.
function selfcheck_mark() {
  const failed = state.selftest && Array.isArray(state.selftest.checks)
    ? state.selftest.checks.filter((c) => !c.ok).length
    : 0;
  if (!failed) return '';
  return `<span class="selfcheck-warn" title="${failed} thing${failed === 1 ? '' : 's'} to fix">${icon('warn')}</span>`;
}

function paint_selftest_button() {
  const button = $('setup').querySelector('[data-act="selftest"]');
  if (!button) return;
  button.innerHTML = `${selfcheck_mark()}Check my setup`;
}

async function load_selftest() {
  try {
    state.selftest = await api('/api/selftest');
  } catch {
    state.selftest = null;
  }
}

function close_setup() {
  $('setup').hidden = true;
  if ($('drawer').hidden) $('scrim').hidden = true;
  sessionStorage.setItem('setup-dismissed', '1');
  state.selftest = null;  // the next open checks again, so the mark is never stale
}

// After any path change the whole app can be looking at a different place, so refresh everything.
async function refresh_all() {
  await Promise.all([load_library(), load_status(), load_setup().catch(() => {}), load_reach(), load_repair()]);
  state.settings = await api('/api/settings');
  await route();
  if (!$('setup').hidden) render_setup();
}

// The path a row currently points at: the picker opens there, so "change" starts from the folder
// that is already configured instead of from wherever Windows remembers last.
function current_folder(key) {
  const setup = state.setup;
  if (setup) {
    const hit = (setup.folders || []).find((f) => f.key === key);
    if (hit && hit.path) return hit.path;
    if (key === 'dll_source') return (setup.source && setup.source.dir) || '';
    if (key === 'steam_root' && setup.steam_root) return setup.steam_root;
  }
  const s = state.settings;
  if (!s) return '';
  if (key === 'steam_root') return (s.steam && s.steam.root) || '';
  const folders = (s.steam && s.steam.paths) || {};
  return folders[key] || '';
}

async function choose_folder(key) {
  const titles = {
    steam_root: 'Where is Steam installed?',
    dll_source: 'Choose the folder with the helper files',
    stplug_in: 'Where should SteaMar put its game files?',
    depotcache: 'Where should Steam keep its manifest files?',
  };
  let folder;
  try {
    folder = (await api('/api/pick-folder', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: titles[key] || 'Choose a folder', key, start: current_folder(key) }),
      // The dialog stays open as long as the person needs; only the dialog itself ends the wait.
      timeout: 10 * 60 * 1000,
    })).folder;
  } catch (err) {
    // Closing the picker is a choice, not a failure.
    if (!/no folder picked/i.test(err.message)) toast(err.message, true);
    return;
  }
  if (folder) await save_path(key, folder);
}

async function save_path(key, folder) {
  try {
    const body = { [key]: folder };
    const next = await api('/api/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    state.settings = next;
    // A different folder deserves a clean slate in the setup panel.
    state.setup_error = '';
    toast('Folder saved');
    await refresh_all();
    // Picking a folder with no steam.exe is the one mistake that quietly breaks everything, so it
    // gets said out loud instead of only showing up as "not set up".
    if (key === 'steam_root') {
      const row = ((state.setup && state.setup.folders) || []).find((f) => f.key === 'steam_root');
      if (row && row.exists === false) toast("Steam isn't in that folder. Pick the folder where Steam is installed.", true);
    }
  } catch (err) {
    toast(err.message, true);
  }
}

let setup_timer = 0;

// The download runs in the engine, not in this request: the panel follows it instead of holding
// a call open for a 16 MB file.
function watch_setup() {
  clearInterval(setup_timer);
  setup_timer = setInterval(async () => {
    try {
      await load_setup();
      render_setup();
      const download = state.setup && state.setup.vendor && state.setup.vendor.download;
      if (!download || !download.active) {
        clearInterval(setup_timer);
        setup_timer = 0;
        await refresh_all();
        if (download && download.error) toast(download.error, true);
        else toast('Everything SteaMar needs is here');
      }
    } catch {
      clearInterval(setup_timer);
      setup_timer = 0;
    }
  }, 400);
}

async function setup_fetch(button) {
  if (button) button.disabled = true;
  const force = button ? button.dataset.force === '1' : false;
  try {
    const started = await api('/api/setup/fetch', { method: 'POST', body: JSON.stringify({ force }) });
    if (started && started.active) {
      state.setup = { ...(state.setup || {}), vendor: { ...((state.setup && state.setup.vendor) || {}), download: started } };
      render_setup();
      watch_setup();
    } else {
      await refresh_all();
    }
  } catch (err) {
    toast(err.message, true);
    if (button) button.disabled = false;
  }
}

async function setup_install(button) {
  if (button) { button.disabled = true; button.textContent = 'Setting up…'; }
  state.setup_error = '';
  try {
    const result = await api('/api/setup/install', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    toast(result.state.ready ? 'SteaMar is set up' : 'Some files are still missing. Try again.');
    await refresh_all();
    if (result.state.ready) {
      render_setup();
      setTimeout(close_setup, 1200);
    }
  } catch (err) {
    // The step keeps the reason: a toast is gone in three seconds and this one needs a decision.
    state.setup_error = err.message;
    if (button) { button.disabled = false; button.textContent = 'Set up'; }
    render_setup();
    toast(err.message, true);
  }
}

async function setup_remove() {
  const go = await ask({
    title: 'Remove the helper files?',
    message: 'SteaMar takes its three helper files out of your Steam folder.\n\nYour added games stay, but they will not load until you set it up again.',
    ok: 'Remove',
    tone: 'bad',
    danger: true,
  });
  if (!go) return;
  try {
    const result = await api('/api/setup/remove', { method: 'POST' });
    toast(result.removed.length ? 'Helper files removed' : 'Nothing to remove');
    await refresh_all();
  } catch (err) {
    toast(err.message, true);
  }
}
