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
