'use strict';

// The page's shared memory (`state`) and its one line to the engine: `api()` uses the desktop
// window's message bridge when there is one and fetch in a plain browser, so the same files run in
// both. Uncaught errors are reported to the engine's log; the desktop input rules are at the end.
// The trap: every view reads `state`. A view that keeps its own copy draws yesterday's answer.

const state = {
  library: [],
  store: null,
  settings: null,
  status: null,
  results: [],
  repair: null,
  store_error: '',
  details: {},
  verdicts: {},
  selftest: null,
  account: null,
  campaign: null,
  account_error: '',
  // The engine's own words about whether there is a door at all, and the address it is at: the
  // offline screen prints the address, because a wrong one looks exactly like an outage.
  configured: true,
  base: '',
  // Set once the app behind the door has been drawn. The gate reopening is not a second boot.
  ready: false,
};

/* The desktop shell answers over postMessage instead of a localhost fetch: one message out,
   one back, no HTTP stack and no port. A plain browser keeps using fetch, so the same files
   still open at 127.0.0.1:8788 while developing. */
const bridge = window.chrome?.webview || null;
let bridge_id = 0;
const bridge_waiting = new Map();

// The one shape every failed call takes, from the shell or from fetch: the engine's code, and words a
// person can read. "The service could not be reached (https://...)" is the engine's log line, not a
// sentence for the window, so that one case is said plainly here once instead of at every caller.
function engine_error(message, code, status) {
  const err = new Error(code === 'unreachable'
    ? "Can't connect right now. Check your internet connection."
    : message || `Something went wrong (${status})`);
  err.code = code || null;
  err.status = status;
  return err;
}

if (bridge) {
  bridge.addEventListener('message', (event) => {
    const reply = event.data;
    const done = reply && bridge_waiting.get(reply.id);
    if (!done) return;
    bridge_waiting.delete(reply.id);
    if (reply.status >= 200 && reply.status < 300) {
      let body = {};
      try { body = reply.text ? JSON.parse(reply.text) : {}; } catch { body = {}; }
      done.resolve(body);
      return;
    }
    let message = '';
    let code = null;
    try {
      const payload = JSON.parse(reply.text);
      message = payload.error || '';
      code = payload.code || null;
    } catch { /* keep the status */ }
    // The same shape the fetch path builds: callers check `code`, not the wording.
    done.reject(engine_error(message, code, reply.status));
  });
}

async function api(path, options) {
  // 30 seconds is plenty for the engine. A person browsing for a folder is not: the picker asks
  // for its own, much longer, limit, and 0 means wait for as long as the dialog is open.
  const limit = options && options.timeout !== undefined ? options.timeout : 30000;
  if (bridge) {
    const id = ++bridge_id;
    const request = {
      id,
      path,
      method: (options && options.method) || 'GET',
      body: options && options.body ? String(options.body) : '',
    };
    return new Promise((resolve, reject) => {
      // A shell that stops answering must not leave the UI waiting forever.
      const timer = limit ? setTimeout(() => {
        if (!bridge_waiting.delete(id)) return;
        reject(new Error('SteaMar took too long to answer. Try again.'));
      }, limit) : null;
      bridge_waiting.set(id, {
        resolve: (value) => { if (timer) clearTimeout(timer); resolve(value); },
        reject: (error) => { if (timer) clearTimeout(timer); reject(error); },
      });
      bridge.postMessage(request);
    });
  }
  // A browser tab gets the same promise as the shell: an answer or a reason, never a hang.
  const controller = new AbortController();
  const timer = limit ? setTimeout(() => controller.abort(), limit) : null;
  let res;
  try {
    res = await fetch(path, { ...(options || {}), signal: controller.signal });
  } catch (err) {
    throw new Error(err.name === 'AbortError' ? 'SteaMar took too long to answer. Try again.' : "SteaMar isn't responding. Try restarting the app.");
  } finally {
    if (timer) clearTimeout(timer);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    // The engine sends { error, code }; the code is what lets a caller tell "no fix for this
    // release" from "the service is not answering" without reading the message.
    throw engine_error(body.error, body.code, res.status);
  }
  return body;
}

/* Anything uncaught ends up in the toast and in out/native.log, so a bad render is visible
   instead of silent. */
function report(kind, detail) {
  console.error(kind, detail);
  api('/api/log', { method: 'POST', body: JSON.stringify({ level: kind, message: String(detail).slice(0, 2000) }) })
    .catch(() => {});
}

window.addEventListener('error', (event) => {
  const detail = event.error?.stack || event.message || 'script error';
  report('error', detail);
  // A bug, not a hiccup: one dialog in plain words. Where it happened is in the log, not on screen.
  if ($('dialog').hidden) return void alert_error('Something unexpected happened. If it keeps happening, restart SteaMar.');
  toast('Something went wrong', true);
});
window.addEventListener('unhandledrejection', (event) => {
  const detail = event.reason?.stack || event.reason?.message || String(event.reason);
  toast(event.reason?.message || 'Something went wrong', true);
  report('promise', detail);
});

/* ---------- desktop input rules ---------- */

// Selection is off in the stylesheet; this keeps the shortcuts and the drag path honest and
// lets the search field behave like a field.
const typing_target = (node) => {
  const el = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
  return Boolean(el?.closest('input, textarea, [contenteditable="true"]'));
};

for (const type of ['selectstart', 'dragstart', 'contextmenu']) {
  document.addEventListener(type, (event) => {
    if (!typing_target(event.target)) event.preventDefault();
  }, true);
}

for (const type of ['copy', 'cut']) {
  document.addEventListener(type, (event) => {
    if (!typing_target(event.target)) event.preventDefault();
  }, true);
}
