'use strict';

// The app's own dialogs and toasts: `open_dialog()` and `ask()` for a question, `alert_error()` for
// a failure, `toast()` for a line that goes away, and the setup check's result. No OS message box.
// The trap: one dialog at a time. Opening a second answers the first with false, so a caller
// that asks twice must await the first answer before it asks again.

/* ---------- dialogs ---------- */
// A question or a failure is drawn by the app, in the app's own surfaces: no OS message box, so
// the look never breaks. One dialog at a time; Enter answers, Escape backs out, focus goes back
// where it came from, and the page behind is inert while it is up.
let dialog_answer = null;
let dialog_return_focus = null;

function close_dialog(answer) {
  const panel = $('dialog');
  if (!panel || panel.hidden) return;
  // The panel keeps what it said while it fades out (motion.css); the next dialog draws over it.
  panel.hidden = true;
  for (const node of [$('main'), $('setup'), $('drawer')]) if (node) node.inert = false;
  // A dialog opened from the panel leaves the panel up, so the page behind stays out of reach.
  $('main').inert = !$('drawer').hidden;
  const back = dialog_return_focus;
  dialog_return_focus = null;
  if (back && document.contains(back)) back.focus();
  const answer_fn = dialog_answer;
  dialog_answer = null;
  if (answer_fn) answer_fn(answer);
}

// Resolves true for the main button, false for the way out.
function open_dialog({ title, message = '', ok = 'OK', cancel = '', tone = '', danger = false }) {
  if (dialog_answer) close_dialog(false);
  const panel = $('dialog');
  dialog_return_focus = document.activeElement;
  panel.innerHTML = `
    <div class="dialog-panel${tone === 'bad' ? ' bad' : ''}" role="dialog" aria-modal="true" aria-labelledby="dialog-title" aria-describedby="dialog-message">
      <h2 id="dialog-title">${esc(title)}</h2>
      <p class="dialog-message" id="dialog-message">${esc(message)}</p>
      <div class="dialog-foot">
        ${cancel ? `<button class="btn ghost" data-answer="0">${esc(cancel)}</button>` : ''}
        <button class="btn ${danger ? 'danger' : 'primary'}" data-answer="1">${esc(ok)}</button>
      </div>
    </div>`;
  panel.hidden = false;
  for (const node of [$('main'), $('setup'), $('drawer')]) if (node) node.inert = true;
  const main_button = panel.querySelector('[data-answer="1"]');
  if (main_button) main_button.focus();
  return new Promise((resolve) => { dialog_answer = resolve; });
}

const ask = (opts) => open_dialog({ cancel: 'Cancel', ...opts });

// The setup check, drawn like the fix instructions: one line per thing that can be wrong, said the
// way a person would say it. Green means nothing to do; red names the folder or file that needs a
// look, and the way out is the Discord button rather than a stack trace.
function selftest_dialog(result) {
  if (dialog_answer) close_dialog(false);
  const panel = $('dialog');
  dialog_return_focus = document.activeElement;
  const checks = Array.isArray(result && result.checks) ? result.checks : [];
  const bad = checks.filter((c) => !c.ok).length;

  panel.innerHTML = `
    <div class="dialog-panel${bad ? ' bad' : ''}" role="dialog" aria-modal="true" aria-labelledby="dialog-title">
      <h2 id="dialog-title">${bad ? `${bad} thing${bad === 1 ? '' : 's'} to look at` : 'Everything checks out'}</h2>
      <ul class="dialog-checks">
        ${checks.map((c) => `
          <li class="${c.ok ? 'ok' : 'bad'}">
            <i class="mark" aria-hidden="true">${icon(c.ok ? 'check' : 'warn')}</i>
            <b>${esc(c.title)}</b>
            <em>${esc(c.detail)}</em>
          </li>`).join('')}
      </ul>
      <div class="dialog-foot">
        ${bad ? `<button class="btn ghost" data-answer="0">Ask on Discord</button>` : ''}
        <button class="btn primary" data-answer="1">Close</button>
      </div>
    </div>`;
  panel.hidden = false;
  for (const node of [$('main'), $('setup'), $('drawer')]) if (node) node.inert = true;
  panel.querySelector('[data-answer="1"]')?.focus();
  return new Promise((resolve) => { dialog_answer = resolve; }).then((yes) => {
    if (!yes && bad) window.open(COMMUNITY, '_blank', 'noreferrer');
  });
}

// A failure worth stopping for: the app says what happened, and where to take it. The stack goes to
// the log for whoever fixes it, never onto the screen of the person who hit it.
function alert_error(err, { title = 'Something went wrong', retry = null } = {}) {
  const message = typeof err === 'string' ? err : (err && err.message) || 'Something unexpected happened.';
  const detail = err && err.stack ? String(err.stack).split('\n').slice(0, 4).join('\n') : '';
  report('alert', detail || message);
  return open_dialog({
    title,
    message,
    ok: retry ? 'Try again' : 'Close',
    cancel: 'Ask on Discord',
    tone: 'bad',
  }).then((yes) => {
    if (yes && retry) return retry();
    if (!yes) window.open(COMMUNITY, '_blank', 'noreferrer');
    return undefined;
  });
}

$('dialog').addEventListener('click', async (event) => {
  const link = event.target.closest('[data-copy-link]');  if (link) {
    await copy_near(link, link.dataset.copyLink);
    return;
  }
  const copy = event.target.closest('[data-copy-pass]');
  if (copy) {
    await copy_near(copy, FIX_PASSWORD);
    return;
  }
  const answer = event.target.closest('[data-answer]');
  if (answer) close_dialog(answer.dataset.answer === '1');
});

document.addEventListener('keydown', (event) => {
  if ($('dialog').hidden) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    const cancel = $('dialog').querySelector('[data-answer="0"]');
    close_dialog(cancel ? false : true);
  } else if (event.key === 'Enter') {
    event.preventDefault();
    event.stopPropagation();
    close_dialog(true);
  }
}, true);

function toast(message, is_error = false) {
  const el = $('toast');
  el.textContent = message;
  el.className = 'toast show' + (is_error ? ' err' : '');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.className = 'toast'; }, 3600);
}
