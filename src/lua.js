'use strict';

// The stplug-in Lua dialect: render() writes a script's text, parse() and validate() read one.
// It touches no file; library.js, gen.js and drop.js do the writing.
// Trap: render() throws on any value that is not digits or a 64-hex key, while validate()
// passes unknown well-formed calls as `other`.

const KEY_RE = /^[0-9a-f]{64}$/i;

// strip a trailing -- comment without breaking quoted strings
function strip_line(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '-' && line[i + 1] === '-') return line.slice(0, i);
  }
  return line;
}

function split_args(inner) {
  const out = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (quote) {
      cur += c;
      if (c === '\\') { cur += inner[++i] || ''; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    if (c === ',') { out.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function kind(tok) {
  if (/^\d+$/.test(tok)) return 'int';
  // A quoted string may contain escapes: the token is only bad when a quote is unterminated.
  if (/^"(?:\\.|[^"\\])*"$/.test(tok) || /^'(?:\\.|[^'\\])*'$/.test(tok)) return 'str';
  return 'bad';
}

const unquote = (tok) => tok.slice(1, -1);

// Everything that goes into a line is a number or a key. The values come from a third-party mirror
// (manifest ids and sizes) and from a service reply (keys, tokens), and Steam runs the file: a newline
// inside one of them would end the line and begin another call nobody asked for, and validate() would
// pass it, because every line of it is a well-formed call.
function digits(value, what) {
  const text = String(value);
  if (!/^\d{1,20}$/.test(text)) throw new Error(`${what} is not a number: ${JSON.stringify(text.slice(0, 40))}`);
  return text;
}

function key_of(value, what) {
  const text = String(value).toLowerCase();
  if (!KEY_RE.test(text)) throw new Error(`${what} is not a 64-character key`);
  return text;
}

function render(appid, depots = {}, manifests = {}, token = null) {
  const app = digits(appid, 'appid');
  const lines = [
    `-- appid ${app}`,
    `-- generated ${new Date().toISOString()} by SteaMar/src/gen.js`,
    '',
    `addappid(${app})`,
  ];
  if (token) lines.push(`addtoken(${app}, "${digits(token, 'token')}")`);
  for (const [depot, key] of Object.entries(depots)) {
    lines.push(`addappid(${digits(depot, 'depot')}, 1, "${key_of(key, `the key for depot ${depot}`)}")`);
  }
  for (const [depot, m] of Object.entries(manifests)) {
    const size = m.size ? `, ${digits(m.size, `the size of depot ${depot}`)}` : '';
    lines.push(`setManifestid(${digits(depot, 'depot')}, "${digits(m.manifest, `the manifest of depot ${depot}`)}"${size})`);
  }
  return lines.join('\n') + '\n';
}

// Dialect in the wild: addappid(id[,flag,key]), addtoken, setManifestid(id, mid[, size]),
// seteticketurl, setStat. Anything else well-formed is recorded as `other`, not failed.
function parse(source) {
  const out = {
    addappid: [], addtoken: [], setManifestid: [], seteticketurl: [], setstat: [], other: [],
    errors: [],
  };
  source.replace(/^\uFEFF/, '').split(/\r?\n/).forEach((raw, i) => {
    const line = strip_line(raw).trim();
    if (!line) return;
    const m = /^([A-Za-z_]\w*)\s*\((.*)\)$/.exec(line);
    if (!m) { out.errors.push({ line: i + 1, text: line, reason: 'not a call' }); return; }
    const name = m[1];
    const args = split_args(m[2]);
    const bad = args.find((a) => kind(a) === 'bad');
    if (bad) { out.errors.push({ line: i + 1, text: line, reason: `bad argument ${bad}` }); return; }
    const at = (n) => (args[n] === undefined ? null : args[n]);
    const as_int = (n) => (at(n) === null ? null : Number(at(n)));
    const as_str = (n) => (at(n) === null ? null : unquote(at(n)));

    if (name === 'addappid') {
      if (args.length < 1 || args.length > 3) { out.errors.push({ line: i + 1, text: line, reason: 'addappid arity' }); return; }
      const key = as_str(2);
      out.addappid.push({ id: String(as_int(0)), flag: as_int(1) ?? 0, key, line: i + 1 });
      return;
    }
    if (name === 'addtoken') {
      if (args.length !== 2 || kind(args[1]) !== 'str' || !/^\d+$/.test(as_str(1))) {
        out.errors.push({ line: i + 1, text: line, reason: 'addtoken needs (appid, "digits")' });
        return;
      }
      out.addtoken.push({ id: String(as_int(0)), token: as_str(1), line: i + 1 });
      return;
    }
    if (name === 'setManifestid') {
      if (args.length < 2 || args.length > 3) { out.errors.push({ line: i + 1, text: line, reason: 'setManifestid arity' }); return; }
      out.setManifestid.push({ depot: String(as_int(0)), manifest: as_str(1), size: as_int(2), line: i + 1 });
      return;
    }
    if (name === 'seteticketurl') {
      out.seteticketurl.push({ url: as_str(0), line: i + 1 });
      return;
    }
    if (name === 'setStat') {
      out.setstat.push({ id: String(as_int(0)), steamid: as_str(1), line: i + 1 });
      return;
    }
    out.other.push({ name, args, line: i + 1 });
  });
  return out;
}

function validate(source) {
  const parsed = parse(source);
  const errors = parsed.errors.map((e) => `line ${e.line}: ${e.reason}: ${e.text}`);

  const call_count = parsed.addappid.length + parsed.addtoken.length + parsed.setManifestid.length
    + parsed.seteticketurl.length + parsed.setstat.length + parsed.other.length;
  if (call_count === 0) errors.push('no calls in file');

  const seen = new Set();
  for (const a of parsed.addappid) {
    if (seen.has(a.id)) errors.push(`line ${a.line}: duplicate addappid(${a.id})`);
    seen.add(a.id);
    if (a.key !== null && !KEY_RE.test(a.key)) errors.push(`line ${a.line}: addappid(${a.id}) key is not 64 hex`);
    if (a.flag !== 0 && a.flag !== 1) errors.push(`line ${a.line}: addappid(${a.id}) flag ${a.flag} is not 0 or 1`);
  }

  return { ok: errors.length === 0, errors, parsed };
}

module.exports = { render, parse, validate, strip_line };
