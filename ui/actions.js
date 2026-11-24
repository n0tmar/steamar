'use strict';

// What a press does: add, remove, install, open in the store, and `handle_act()`, which every
// button with a `data-act` attribute ends up in. The listeners are in events.js.
// Trap: a button names its branch here as text (`data-act="..."`). Renaming one side and not
// the other leaves a button that does nothing and says nothing.

/* ---------- actions ---------- */

async function install_app(appid) {
  try {
    await api('/api/install', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appid, action: 'install' }),
    });
    toast('Steam is opening the installer…');
  } catch (err) {
    toast(err.message, true);
  }
}

// An unreleased game has no installer to offer, but it does have a page, and the wishlist button
// lives there. `steam://store` opens that page in the Steam client.
async function open_store(appid) {
  try {
    await api('/api/install', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appid, action: 'store' }),
    });
    toast('Opening the store page in Steam…');
  } catch (err) {
    toast(err.message, true);
  }
}

// Writing the script and opening Steam's installer are two different things: the script is already
// on disk when install runs, so an install that fails can never be reported as a failed add.
async function add_app(appid, file, also_install = false) {
  const button = $('drawer').querySelector('[data-add]');
  if (button) { button.disabled = true; button.textContent = 'Adding…'; }
  let result;
  try {
    result = await api('/api/add', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appid, file: file || undefined }),
    });
  } catch (err) {
    // The engine's reason is written for the log; a person gets the one thing they can do about it.
    report('add', err.message);
    toast(/steam did not close/i.test(err.message)
      ? "Steam didn't close. Close any running game and try again."
      : err.code === 'unreachable' ? "Can't connect right now. Check your internet connection."
        : "Couldn't add this game right now. Try again later.", true);
    if (button) { button.disabled = false; button.textContent = 'Add to library'; }
    return false;
  }

  toast(`${result.name} added`);
  // A script that was written and cannot install is worth saying out loud: the alternative is a
  // person finding out when Steam stops at 88500005 minutes later.
  if (result.renderable === false) {
    toast(`${result.name} was added, but Steam won't be able to download it yet`, true);
  }
  await Promise.all([load_library(), load_status()]);
  await route();
  await open_drawer(result.appid, { file: result.file.split(/[\\/]/).pop(), name: result.name });

  if (also_install) {
    try {
      await install_app(result.appid);
    } catch (err) {
      toast(`${err.message}. The game is added; press Install in its panel to try again.`, true);
    }
  }

  // Steam built its license table when it started: removing the script took this id out of it,
  // and the script going back does not put it back. Only a fresh Steam reads it again.
  if (result.steam_restart_needed) {
    const go = await ask({
      title: 'Restart Steam to finish',
      message: 'Steam only reads its game list when it starts, so this game shows up after a restart.\n\nYour other games are not affected.',
      ok: 'Restart Steam',
      cancel: 'Later',
    });
    if (go) {
      try {
        await api('/api/steam/restart', { method: 'POST' });
        toast('Steam is restarting');
      } catch (err) {
        alert_error(err, { title: "Steam didn't restart" });
      }
    }
  }
  return true;
}

async function remove_app(file) {
  try {
    await api('/api/remove', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ file }),
    });
    toast('Removed from your library');
    close_drawer();
    await Promise.all([load_library(), load_status()]);
    await route();
  } catch (err) {
    toast(err.message, true);
  }
}

async function handle_act(el) {
  const act = el.dataset.act;

  // The five checks the doctor prints, in the window, in plain words: a person should not need a
  // terminal to find out that their Steam folder is the wrong one.
  if (act === 'selftest') {
    el.disabled = true;
    try {
      const result = await api('/api/selftest');
      state.selftest = result;
      paint_selftest_button();
      await selftest_dialog(result);
    } catch (err) {
      toast(err.message, true);
    } finally {
      el.disabled = false;
    }
    return;
  }

  if (act === 'setup-fetch') return setup_fetch(el);
  if (act === 'setup-install') return setup_install(el);
  if (act === 'setup-remove') return setup_remove();
  if (act === 'setup-open') {
    if (!state.setup) await load_setup();
    return open_setup();
  }

  /* ---------- the account gate ---------- */

  if (act === 'login') return start_login(el);

  // The retry on the two screens where there is no code to enter: the service has not answered yet,
  // or it is out of reach. It skips the engine's wait between attempts, because a person asked.
  if (act === 'account-retry') {
    el.disabled = true;
    await load_account({ force: true });
    render_gate();
    if (!gate_reason()) {
      await after_gate();
    } else {
      el.disabled = false;
    }
    return;
  }

  // "Check again" on the join screen and on the paused one: re-ask the service, redraw, and if the
  // answer changed to a yes, continue booting as if nothing had happened.
  if (act === 'gate-check') {
    el.disabled = true;
    await api('/api/campaign', { method: 'POST' }).catch(() => {});
    // Forced: the engine waits for the service's answer, so "check again" shows the new role at once.
    await load_account({ force: true });
    render_gate();
    render_status();
    if (!gate_reason()) await after_gate();
    else el.disabled = false;
    return;
  }

  // Give. The page is the site's, in a real browser: a payment form inside this window is a payment
  // form nobody should be asked to trust.
  if (act === 'donate') {
    try {
      await api('/api/donate', { method: 'POST' });
      toast('The donation page is open in your browser');
    } catch (err) {
      toast(err.message, true);
    }
    return;
  }

  // The public page on the site and its editor, in the browser like the donation page.
  if (act === 'profile-view' || act === 'profile-edit') {
    const edit = act === 'profile-edit';
    try {
      await api('/api/profile', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ edit }) });
      toast(edit ? 'The profile editor is open in your browser' : 'Your profile is open in your browser');
    } catch (err) {
      toast(err.message, true);
    }
    return;
  }

  // One of the person's links, asked for by its place in their list: the engine looks the address up
  // in the account it holds, so the window never hands it one.
  if (act === 'profile-link') {
    try {
      await api('/api/profile', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ link: Number(el.dataset.link) }) });
      toast('Opened in your browser');
    } catch (err) {
      toast(err.message, true);
    }
    return;
  }

  // The link to the public page, onto the clipboard; the button itself says it worked.
  if (act === 'profile-copy') {
    const url = state.account && state.account.profile ? state.account.profile.url : '';
    if (!url || !(await copy_text(url))) {
      toast('Couldn\'t copy the link. Try again.', true);
      return;
    }
    const word = el.querySelector('b');
    el.classList.add('is-done');
    if (word) word.textContent = 'Copied';
    setTimeout(() => {
      el.classList.remove('is-done');
      if (word) word.textContent = 'Copy';
    }, 1800);
    return;
  }

  if (act === 'account-open') return open_account();
  if (act === 'logout') return sign_out();

  if (act === 'refresh') {
    // Rescan means re-read everything the app shows - the scripts on disk, the counts, the
    // settings, the store shelves - not just the list of games.
    el.disabled = true;
    el.setAttribute('aria-busy', 'true');
    try {
      await load_store(true).catch(() => {});
      await refresh_all();
      toast('Library refreshed');
    } catch (err) {
      toast(err.message, true);
    } finally {
      el.disabled = false;
      el.removeAttribute('aria-busy');
    }
    return;
  }

  if (act === 'reveal') {
    try { await api('/api/reveal', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target: el.dataset.target }) }); }
    catch (err) { toast(err.message, true); }
    return;
  }

  // The person pressing check. The same question boot asks, with the cache skipped: this is the one
  // way to see the update channel work while the build is current.
  if (act === 'update-check') {
    if (el.disabled) return;
    el.disabled = true;
    toast('Checking for updates…');
    try {
      const answer = await api('/api/update-check', { method: 'POST' });
      if (state.settings && state.settings.app) state.settings.app = { ...state.settings.app, update: answer.update };
      render_settings();
      render_status();
      const now = answer.update && answer.update.state;
      toast(now === 'optional' ? 'An update is available'
        : now === 'required' ? 'This version is too old. Please update.'
          : now === 'none' ? 'You have the latest version'
            : "Couldn't check for updates. Try again later.");
    } catch (err) {
      el.disabled = false;
      toast(err.message, true);
    }
    return;
  }

  // The update row. In the window it downloads, checks the checksum the service signed, and restarts
  // itself: the swap is the shell's job because a process cannot replace the exe it is running. In a
  // browser tab it opens the published address, because a tab that promised a restart would be lying.
  if (act === 'update') {
    const url = el.dataset.url || '';
    if (!/^https?:\/\//i.test(url)) { toast("This update can't be downloaded right now. Try again later.", true); return; }

    if (!bridge) {
      try { await api('/api/open-link', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url }) }); }
      catch (err) { toast(err.message, true); }
      return;
    }

    el.disabled = true;
    const label = el.innerHTML;
    const step = { downloading: 'Downloading', verifying: 'Checking', unpacking: 'Unpacking', ready: 'Restarting' };
    try {
      let answer = await api('/api/update', { method: 'POST' });
      while (answer && (answer.state === 'downloading' || answer.state === 'verifying' || answer.state === 'unpacking')) {
        el.innerHTML = `${icon('download')}${step[answer.state] || answer.state}${answer.state === 'downloading' ? ` ${answer.percent || 0}%` : ''}`;
        await new Promise((done) => setTimeout(done, 600));
        answer = await api('/api/update');
      }
      if (!answer || answer.state !== 'ready') throw new Error((answer && answer.error) || "The update didn't finish. Try again.");
      el.innerHTML = `${icon('refresh')}Restarting`;
      toast('Restarting with the new version…');
      // The window closes as this returns; the promise may never settle, and that is the success case.
      await api('/api/update/apply', { method: 'POST' }).catch(() => null);
    } catch (err) {
      el.disabled = false;
      el.innerHTML = label;
      toast(err.message, true);
    }
    return;
  }

  // A repair is one press and nothing else: close Steam when it has to, put the old files aside,
  // and leave Steam the way it was found — or closed, while there is still a setup to run.
  if (act === 'repair-now') {
    const was_ready = Boolean(state.setup && state.setup.ready);
    state.repairing = true;
    render_setup();
    try {
      const result = await api('/api/repair', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ close_steam: true, restart: was_ready }),
        // Closing Steam, hashing helper files and rewriting a config is file work, not a request to rush.
        timeout: 180000,
      });
      state.repairing = false;
      state.repair = result.state || null;
      await refresh_all();
      if (result.failed && result.failed.length) toast("Some of it didn't work. Press Fix it again.", true);
      else toast(was_ready ? 'Steam is fixed' : 'Fixed. Carry on with the setup.');
    } catch (err) {
      state.repairing = false;
      render_setup();
      toast(err.message, true);
    }
    return;
  }

  if (act === 'store-retry') {
    el.disabled = true;
    try {
      await load_store(true);
    } catch (err) {
      toast(err.message, true);
    } finally {
      el.disabled = false;
    }
    return;
  }

  if (act === 'pull') {
    el.disabled = true;
    const label = el.textContent;
    el.textContent = 'Updating…';
    try {
      const { results } = await api('/api/pull', { method: 'POST' });
      const moved = results.filter((r) => r.before !== r.after).length;
      toast(moved ? 'Game list updated' : 'The game list is already up to date');
      state.settings = await api('/api/settings');
      render_settings();
    } catch (err) {
      toast(err.message, true);
    } finally {
      el.disabled = false;
      el.textContent = label;
    }
    return;
  }

  if (act === 'clear-cache') {
    const go = await ask({
      title: 'Clear saved pictures?',
      message: 'SteaMar deletes the covers and banners it saved and downloads them again as you browse.\n\nYour games are not touched.',
      ok: 'Clear',
    });
    if (!go) return;
    el.disabled = true;
    try {
      await api('/api/cache/clear', { method: 'POST' });
      state.settings = await api('/api/settings');
      state.store = null;
      toast('Saved pictures cleared');
      render_settings();
    } catch (err) { toast(err.message, true); }
    finally { el.disabled = false; }
    return;
  }

  if (act === 'restore') {
    try {
      const result = await api('/api/restore', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ file: el.dataset.file }),
      });
      toast('Restored');
      await load_library();
      state.settings = await api('/api/settings');
      render_settings();
    } catch (err) { toast(err.message, true); }
  }
}
