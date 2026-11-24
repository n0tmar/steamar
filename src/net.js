'use strict';

// The engine's HTTP client: kept-alive pools, decompression and retries behind a fetch-shaped call.
// It knows nothing about signing or the service; transport.js does.
// Trap: a GET is retried up to three times, a POST only when the connection never opened.

// One connection pool, one retry policy, one place that knows how long to wait.
//
// Why this exists rather than plain `fetch`: the app makes four calls at boot and then polls, and every
// one of them used to pay for a fresh TCP handshake and a fresh TLS handshake to the same host. On a
// phone tether that is half a second each. A kept-alive agent makes the second and every later call
// cost one round trip and no handshake at all.
//
// It also fixes the three things a client gets wrong under load:
//
//   compression   the reply is gzipped or brotli-compressed by the edge, and something has to unwrap it
//   retries       a 503 during a deploy, or a 429 with Retry-After, is not a bug in this app
//   idempotence   a GET is retried three times; a POST is retried only when the connection never opened,
//                 because a payment intent that ran twice is worse than an error the person can see

const http = require('node:http');
const https = require('node:https');
const zlib = require('node:zlib');
const { URL } = require('node:url');

const KEEP_ALIVE_MS = 20_000;
const MAX_SOCKETS = 8;

// Two pools, because http and https need different agents. The app only ever uses https in production
// and http on loopback, and both should reuse their sockets.
const agents = {
  'http:': new http.Agent({ keepAlive: true, keepAliveMsecs: KEEP_ALIVE_MS, maxSockets: MAX_SOCKETS }),
  'https:': new https.Agent({ keepAlive: true, keepAliveMsecs: KEEP_ALIVE_MS, maxSockets: MAX_SOCKETS }),
};

const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
// Failures that happened before a single byte of the request was sent: safe to retry, whatever the verb.
const RETRY_CODES = new Set(['ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND', 'ENETUNREACH', 'EHOSTUNREACH', 'ERR_SOCKET_CLOSED']);

const MAX_TRIES = 3;
const BASE_DELAY_MS = 200;
const MAX_DELAY_MS = 5_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Exponential with jitter, so that a thousand installs waking up at once do not retry in step.
function backoff(attempt) {
  const base = Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), MAX_DELAY_MS);
  return Math.round(base * (0.5 + Math.random() * 0.5));
}

function decode(body, encoding) {
  const code = String(encoding || '').toLowerCase().trim();
  if (!code || code === 'identity') return body;
  try {
    if (code === 'gzip' || code === 'x-gzip') return zlib.gunzipSync(body);
    if (code === 'br') return zlib.brotliDecompressSync(body);
    if (code === 'deflate') return zlib.inflateSync(body);
  } catch {
    // A body that will not unwrap is a body this app cannot use; the parser below says so in one place.
  }
  return body;
}

function once(target, opts) {
  return new Promise((resolve, reject) => {
    const url = new URL(target);
    const pool = agents[url.protocol];
    const transport = url.protocol === 'https:' ? https : http;

    const headers = { 'accept-encoding': 'gzip, br', ...(opts.headers || {}) };
    if (opts.body && headers['content-type'] === undefined) headers['content-type'] = 'application/json';
    if (opts.body) headers['content-length'] = String(Buffer.byteLength(opts.body));

    const req = transport.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: opts.method || 'GET',
        headers,
        // Only reuse a pooled socket for the host it was opened to, which the agent already guarantees.
        agent: pool,
        timeout: 0,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () => {
          const raw = decode(Buffer.concat(chunks), res.headers['content-encoding']);
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            headers: {
              get: (name) => {
                const value = res.headers[String(name).toLowerCase()];
                return value === undefined ? null : value;
              },
              raw: res.headers,
            },
            text: async () => raw.toString('utf8'),
            json: async () => JSON.parse(raw.toString('utf8')),
            bytes: async () => raw,
          });
        });
      },
    );

    // A caller that passed AbortSignal.timeout expects a timeout to look like one.
    if (opts.signal) {
      if (opts.signal.aborted) {
        req.destroy(Object.assign(new Error('the call was cancelled'), { name: 'AbortError', code: 'aborted' }));
        return;
      }
      opts.signal.addEventListener('abort', () => {
        req.destroy(Object.assign(new Error('the call timed out'), { name: 'AbortError', code: 'timeout' }));
      }, { once: true });
    }

    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

// The drop-in: same shape the rest of the app already speaks (ok, status, headers.get, text, json).
async function fetch(target, opts = {}) {
  const method = String(opts.method || 'GET').toUpperCase();
  const idempotent = method === 'GET' || method === 'HEAD';

  for (let attempt = 1; ; attempt += 1) {
    try {
      const reply = await once(target, opts);

      // A status worth retrying, but only where asking twice cannot change the world.
      if (idempotent && attempt < MAX_TRIES && RETRY_STATUS.has(reply.status)) {
        const after = Number(reply.headers.get('retry-after'));
        const wait = Number.isFinite(after) && after > 0 ? Math.min(after * 1000, MAX_DELAY_MS) : backoff(attempt);
        await sleep(wait);
        continue;
      }
      return reply;
    } catch (err) {
      const safe = RETRY_CODES.has(err.code) && (idempotent || err.code !== 'ERR_SOCKET_CLOSED');
      if (attempt >= MAX_TRIES || !safe || opts.signal?.aborted) throw err;
      await sleep(backoff(attempt));
    }
  }
}

module.exports = { fetch, agents, backoff };
