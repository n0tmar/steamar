'use strict';

// The Settings view and its zoom slider: Steam's state, the account, the Steam folder, text size and
// the version. Everything a person rarely needs sits in one closed "Advanced" group at the bottom.
// Folder picking and saving live in setup.js.
// Trap: it reads `state.settings` and `state.setup` and fetches neither; the router loads them first.

function render_settings() {
  const view = $('view-settings');
  const s = state.settings;
  if (!s) { view.innerHTML = '<p class="hint">Loading settings\u2026</p>'; return; }

  const art = s.storage.imgcache;

  const row = (title, note, control) => `
    <div class="srow">
      <div class="srow-text"><b>${title}</b>${note ? `<em>${note}</em>` : ''}</div>
      <div class="srow-side">${control || ''}</div>
    </div>`;

  const group = (title, right, body) => `
    <section class="group">
      <div class="group-head"><h3>${title}</h3>${right ? `<span class="right">${right}</span>` : ''}</div>
      <div class="group-body">${body}</div>
    </section>`;

  // Folders are picked, not typed: the path is shown in mono and one button changes it. A folder the
  // person chose offers the way back to the one SteaMar finds by itself.
  const folder_row = (item, label) => `
    <div class="srow">
      <div class="srow-text"><b>${label}</b><em class="mono" title="${esc(item.path)}">${esc(item.path)}</em></div>
      <div class="srow-side">
        <button class="btn ghost sm" data-pick="${item.key}">${icon('folder')}Change</button>
        ${item.auto || item.key === 'steam_root' ? '' : `<button class="btn ghost sm" data-pick-reset="${item.key}" title="Go back to the folder SteaMar finds by itself">${icon('refresh')}Reset</button>`}
      </div>
    </div>`;

  const setup = state.setup;
  const folders = setup ? setup.folders : [
    { key: 'steam_root', path: s.steam.root, auto: true },
    { key: 'stplug_in', path: s.steam.paths.stplug_in, auto: s.steam.paths.auto.stplug_in },
    { key: 'depotcache', path: s.steam.paths.depotcache, auto: s.steam.paths.auto.depotcache },
  ];
  const folder = (key) => folders.find((f) => f.key === key) || { key, path: '', auto: true };

  // Text size is a once-in-a-while adjustment. A slider with a live preview beats three buttons - the
  // whole page is the preview, and the number says exactly where you landed.
  const zoom = Number(state.status && state.status.zoom) || 115;
  const size_row = row('Text size', 'Makes everything in this window bigger or smaller',
    `<div class="sizer">
       <span class="sizer-a small" aria-hidden="true">A</span>
       <input id="zoom-range" type="range" min="100" max="130" step="5" value="${zoom}"
              aria-label="Text size" aria-valuetext="${zoom}%">
       <span class="sizer-a big" aria-hidden="true">A</span>
       <output id="zoom-out" class="sizer-pct" for="zoom-range">${zoom}%</output>
     </div>`);

  // The Steam side is the app's own health, so it reads as a status card at the top of the page.
  // When something is wrong the card says it in one sentence and opens the setup steps - the only
  // place a repair lives - so there is nothing here to read or choose.
  const rep = state.repair;
  const trouble = rep ? rep.summary.state !== 'ok' : false;
  const steam_gone = Boolean(rep && rep.findings.some((f) => f.id === 'steam-missing'));
  const state_kind = setup && setup.ready && !trouble ? 'ok' : 'warn';
  const headline = !setup
    ? 'Checking Steam\u2026'
    : !setup.ready
      ? 'Steam is not set up yet'
      : steam_gone
        ? 'Steam is not where SteaMar expects'
        : trouble
          ? 'Steam needs a small repair'
          : 'Steam is set up';
  const helper_detail = !setup
    ? 'Looking for the helper files'
    : !setup.ready
      ? (setup.steam_running
        ? 'Steam is running. Close it, then set up.'
        : setup.vendor && setup.vendor.ready
          ? 'Steam needs three helper files before added games show up.'
          : 'Download the helper files, then press Set up.')
      : steam_gone
        ? 'That folder is not a Steam install. Pick the right one.'
        : trouble
          ? 'Press Repair. SteaMar fixes it and carries on.'
          : 'The helper files are in place.';
  const card_action = !setup
    ? ''
    : !setup.ready
      ? `<button class="btn sm" data-act="setup-open">${icon('download')}${setup.vendor && setup.vendor.ready ? 'Set up' : 'Get the files'}</button>`
      : steam_gone
        ? `<button class="btn sm" data-pick="steam_root">${icon('folder')}Find Steam</button>`
        : trouble
          ? `<button class="btn sm" data-act="setup-open">${icon('check')}Repair</button>`
          : `<button class="btn ghost sm danger" data-act="setup-remove">${icon('trash')}Remove</button>`;
  const helper_card = `
    <section class="status ${state_kind}" aria-live="polite">
      <span class="status-mark" aria-hidden="true">${state_kind === 'ok' ? icon('check') : icon('warn')}</span>
      <div class="status-text">
        <b>${headline}</b>
        <em>${helper_detail}</em>
      </div>
      <div class="status-side">${card_action}</div>
    </section>`;

  // The update row is there whether or not there is news: "you have the latest version" is an answer
  // too, and a row that only appears when something is wrong is a row nobody can check on demand.
  const update = (s.app && s.app.update) || null;
  const update_state = (update && update.state) || 'unknown';
  const update_title = update_state === 'required' ? 'Update required'
    : update_state === 'optional' ? `Version ${esc(update.version || '')} is available`
      : update_state === 'none' ? 'You have the latest version' : 'Updates';
  const update_note = update_state === 'required' ? 'This version is too old. Update to keep using SteaMar.'
    : update_state === 'optional' ? esc(update.notes || 'A newer version of SteaMar is out.')
      : update_state === 'none' ? (update.checked_at ? `Checked ${esc(ago(update.checked_at))}` : '')
        : "SteaMar hasn't checked for updates yet.";
  const update_row = row(update_title, update_note,
    update && update_state !== 'none' && update.url
      // A window replaces itself: the button downloads, checks the download and restarts. A browser
      // tab cannot, so it opens the published address instead.
      ? `<button class="btn sm" data-act="update" data-url="${esc(update.url)}">${icon('download')}${bridge ? 'Update now' : 'Download'}</button>`
      : `<button class="btn ghost sm" data-act="update-check">${icon('refresh')}Check</button>`);

  // The account is not here: it opens from the profile in the corner, as its own small window.

  // Everything a person opens this page for is above; what they almost never need is folded away.
  const advanced = `
    <details class="group more">
      <summary class="group-head"><h3>Advanced</h3><span class="right">${icon('right', 'more-mark')}</span></summary>
      <div class="group-body">
        ${folder_row(folder('stplug_in'), 'Game files folder')}
        ${folder_row(folder('depotcache'), 'Manifest folder')}
        ${row('Saved pictures', `${art.files.toLocaleString()} ${art.files === 1 ? 'picture' : 'pictures'} \u00b7 ${kb(art.bytes)}`,
          `<button class="btn ghost sm" data-act="clear-cache" title="Delete the saved covers. They download again as you browse.">${icon('trash')}Clear</button>`)}
        ${row('App folder', 'Where SteaMar keeps its own files', `<button class="btn ghost sm" data-act="reveal" data-target="project">${icon('folder')}Open</button>`)}
      </div>
    </details>`;

  view.innerHTML = `
    <div class="settings">

      ${helper_card}

      ${group('Steam', s.steam.source === 'env' ? '<span class="tag">set by STEAM_ROOT</span>' : '', folder_row(folder('steam_root'), 'Steam folder'))}

      ${group('Display', '', size_row)}

      ${group('About', `v${esc(s.app.version)}`, `
        ${update_row}
        ${row('Help', 'Questions or problems? Ask on our Discord.', `<a class="btn ghost sm" href="${COMMUNITY}" target="_blank" rel="noreferrer noopener">${DISCORD}Discord</a>`)}
      `)}

      ${advanced}

    </div>`;

  bind_zoom_slider();
}

// The slider applies as it moves: the WebView scales the whole page, so the preview is the app
// itself. One call per pause, not per pixel, and the number is written back from the shell.
function bind_zoom_slider() {
  const range = $('zoom-range');
  if (!range) return;
  const out = $('zoom-out');
  let timer = null;
  const apply = async (percent) => {
    // Only the desktop window owns a WebView it can scale. A browser tab has no controller, so the
    // call is not sent at all: the engine has no such route, and asking it was a 404 in the log for
    // a control that was working. CSS zoom stands in for development.
    if (!bridge) {
      document.documentElement.style.zoom = String(percent / 100);
      state.status = { ...state.status, zoom: percent };
      return;
    }
    try {
      const result = await api('/api/text-size', { method: 'POST', body: JSON.stringify({ percent }) });
      state.status = { ...state.status, zoom: result.zoom };
    } catch {
      // A shell that cannot scale the page still gets the same size on screen.
      document.documentElement.style.zoom = String(percent / 100);
      state.status = { ...state.status, zoom: percent };
    }
  };
  range.addEventListener('input', () => {
    const percent = Number(range.value);
    out.textContent = `${percent}%`;
    range.setAttribute('aria-valuetext', `${percent}%`);
    clearTimeout(timer);
    timer = setTimeout(() => apply(percent), 120);
  });
}
