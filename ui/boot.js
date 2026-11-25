'use strict';

// Starts the page: the icons, the account door, then everything behind it. Loaded last.
// The trap: index.html loads these files in order, and code that runs while a file loads may only
// use what that file or an earlier one declared. A call that runs at load belongs here.

/* ---------- boot ---------- */

async function boot() {
  paint_icons();
  // The door first: who is on this PC decides whether there is an app to draw at all. Everything
  // else - the library, the status bar, the setup steps, the store shelves - waits behind it.
  await load_account();
  // render_gate() also starts the account watch, inside or not: without it, a person who was already
  // in at boot kept the tier they started with until the next start.
  render_gate();
  if (!gate_reason()) await after_gate();
  if (state.account && state.account.source === 'saved') confirm_account().catch(() => {});
  // Last, and never waited on: the engine is already fetching a newer build in the background.
  watch_update().catch(() => {});
}

/* ---------- the update chip ---------- */

// The engine downloads and checks a newer build at start. This only says when it is ready: the files
// can be replaced only while the window is closed, so the press is the person's.
async function watch_update() {
  const chip = $('update-chip');
  const text = $('update-chip-text');
  const note = $('update-note');
  const title = $('update-note-title');
  const close = $('update-note-close');
  if (!chip || !text || !bridge) return;
  let shown = '1';
  if (close && note) {
    close.addEventListener('click', () => {
      note.hidden = true;
      try { sessionStorage.setItem('update-put-away', shown); } catch {}
    });
  }
  const busy = ['downloading', 'verifying', 'unpacking'];
  const began = Date.now();
  for (;;) {
    const job = (await api('/api/update')) || {};
    if (job.state === 'ready') {
      chip.hidden = false;
      chip.disabled = false;
      text.textContent = 'Restart to update';
      if (note && job.version) {
        shown = String(job.version);
        try {
          if (sessionStorage.getItem('update-put-away') !== shown) {
            if (title) title.textContent = `SteaMar ${shown} is ready.`;
            note.hidden = false;
          }
        } catch {}
      }
      return;
    }
    if (busy.includes(job.state)) {
      chip.hidden = false;
      chip.disabled = true;
      text.textContent = job.state === 'downloading' ? `Update ${job.percent || 0}%` : 'Preparing update';
    } else if (job.state !== 'idle' || Date.now() - began > 20000) {
      // Nothing to fetch, or a fetch that failed: the row in Settings stays the place that says why.
      return;
    }
    await new Promise((done) => setTimeout(done, 2000));
  }
}

(async () => {
  try {
    await boot();
  } catch (err) {
    // The window is up but the engine never answered (a missing runtime, a blocked port). Say it
    // in the app and offer another go, instead of a screen of empty shelves.
    await alert_error(err.message, {
      title: "SteaMar didn't start properly",
      retry: () => boot().catch((again) => alert_error(again.message, { title: 'Still not working' })),
    });
  }
})();
