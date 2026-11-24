// Does a write still reach the engine from the real page? The origin guard must not lock out the
// app's own bridge, and it must refuse a foreign one. Run with the app open (CDP on 9222).
async function main() {
  const list = await fetch('http://127.0.0.1:9222/json/list').then((r) => r.json());
  const page = list.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const waiting = new Map();
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const n = ++id;
    waiting.set(n, { resolve, reject });
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    const slot = waiting.get(msg.id);
    if (!slot) return;
    waiting.delete(msg.id);
    if (msg.error) slot.reject(new Error(msg.error.message));
    else slot.resolve(msg.result);
  };
  await new Promise((resolve) => { ws.onopen = resolve; });
  await send('Runtime.enable');

  const run = async (expr) => {
    const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (res.exceptionDetails) return { threw: res.exceptionDetails.exception?.description || res.exceptionDetails.text };
    return res.result.value;
  };

  // through the app's own api(): postMessage to the shell, shell asks the engine
  console.log('bridge POST /api/log ->', JSON.stringify(await run(
    "api('/api/log', { method: 'POST', body: JSON.stringify({ level: 'info', message: 'origin guard smoke' }) }).then(() => 'ok', (e) => 'rejected: ' + e.message)",
  )));

  // the same shape a foreign page would send: a plain fetch with its own origin
  console.log('page fetch to the engine ->', JSON.stringify(await run(
    "fetch('http://127.0.0.1:8788/api/log', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{\"level\":\"info\",\"message\":\"direct\"}' }).then((r) => r.status + ' ' + r.statusText, (e) => 'blocked by the browser: ' + e.message)",
  )));

  ws.close();
}
main().catch((err) => { console.error(err.message); process.exit(1); });
