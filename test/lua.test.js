'use strict';

// The stplug-in file is the one thing this app writes into Steam's own folder, so it gets the
// strictest tests: real-world shapes on disk in test/fixtures, plus generated text from render().
//   npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const lua = require('../src/lua.js');

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

test('a plain file from disk validates and parses to the calls it contains', () => {
  const result = lua.validate(fixture('valid-basic.lua'));
  assert.equal(result.ok, true, result.errors.join('\n'));

  const p = result.parsed;
  assert.deepEqual(p.addappid.map((a) => a.id), ['730', '731']);
  assert.equal(p.addappid[0].key, null);
  assert.equal(p.addappid[0].flag, 0);
  assert.equal(p.addappid[1].key, KEY);
  assert.equal(p.addappid[1].flag, 1);
  assert.deepEqual(p.addtoken, [{ id: '730', token: '1234567890', line: 4 }]);
  assert.deepEqual(p.setManifestid, [
    { depot: '731', manifest: '4813426003549064298', size: 2614315776, line: 6 },
  ]);
  assert.equal(p.seteticketurl[0].url, 'https://example.invalid/ticket');
  assert.equal(p.setstat[0].steamid, '76561198000000000');
  // an unknown but well-formed call is recorded, never treated as a failure
  assert.deepEqual(p.other.map((o) => o.name), ['setDLC']);
  assert.deepEqual(p.errors, []);
});

test('quotes keep commas, parens and -- inside the string', () => {
  const result = lua.validate(fixture('quoted-tricky.lua'));
  assert.equal(result.ok, true, result.errors.join('\n'));
  const p = result.parsed;
  assert.equal(p.seteticketurl[0].url, 'https://example.invalid/a(b),c--d');
  assert.equal(p.addtoken[0].token, '76561198000000000');
  assert.equal(p.setManifestid[0].manifest, '10, 20');
  // parse() reports the text exactly as written; an upper-case key still validates
  assert.equal(p.addappid[0].key, 'FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF');
});

test('a CRLF file with a BOM parses exactly like the LF one', () => {
  const crlf = '\uFEFF' + fixture('valid-basic.lua').replace(/\n/g, '\r\n');
  const a = lua.validate(fixture('valid-basic.lua'));
  const b = lua.validate(crlf);
  assert.equal(b.ok, true, b.errors.join('\n'));
  assert.deepEqual(b.parsed.addappid, a.parsed.addappid);
  assert.deepEqual(b.parsed.setManifestid, a.parsed.setManifestid);
});

test('every way a file can be wrong is reported with its line number', () => {
  const result = lua.validate(fixture('broken.lua'));
  assert.equal(result.ok, false);
  const said = result.errors.join('\n');
  assert.match(said, /line 2: duplicate addappid\(730\)/);
  assert.match(said, /line 3: addappid\(731\) key is not 64 hex/);
  assert.match(said, /line 4: addappid\(732\) flag 2 is not 0 or 1/);
  assert.match(said, /line 5: addappid arity/);
  assert.match(said, /line 6: addtoken needs \(appid, "digits"\)/);
  assert.match(said, /line 7: bad argument xyz/);
  assert.match(said, /line 8: not a call/);
});

test('a file with no calls is an error, not an empty pass', () => {
  const result = lua.validate(fixture('empty.lua'));
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, ['no calls in file']);
  assert.deepEqual(result.parsed.addappid, []);
});

test('render() produces text that validate() accepts, with and without extras', () => {
  const bare = lua.render(730);
  const bare_result = lua.validate(bare);
  assert.equal(bare_result.ok, true, bare_result.errors.join('\n'));
  assert.deepEqual(bare_result.parsed.addappid, [{ id: '730', flag: 0, key: null, line: 4 }]);

  const full = lua.render(
    730,
    { 731: KEY.toUpperCase() },
    { 731: { manifest: '4813426003549064298', size: 2614315776 } },
    '1234567890',
  );
  const full_result = lua.validate(full);
  assert.equal(full_result.ok, true, full_result.errors.join('\n'));
  const p = full_result.parsed;
  assert.equal(p.addtoken[0].token, '1234567890');
  assert.equal(p.addappid[1].key, KEY, 'render must lower-case the key it writes');
  assert.equal(p.setManifestid[0].size, 2614315776);
});

test('render() writes only numbers and keys, so a hostile value cannot add a call of its own', () => {
  const inject = '1")\nload("http://evil.example")\nsetManifestid(5, "9';
  const refuses = (label, run) => assert.throws(run, /is not a (number|64-character key)/, label);

  refuses('manifest', () => lua.render(730, {}, { 731: { manifest: inject } }));
  refuses('size', () => lua.render(730, {}, { 731: { manifest: '1', size: '5)\nload("x")\n--' } }));
  refuses('depot in the manifests', () => lua.render(730, {}, { '731, 1)\nload("x")\n--': { manifest: '1' } }));
  refuses('depot in the keys', () => lua.render(730, { '731, 1, "")\nload("x")\n--': KEY }, {}));
  refuses('key', () => lua.render(730, { 731: `${KEY}")\nload("x")\n--` }, {}));
  refuses('short key', () => lua.render(730, { 731: 'abc' }, {}));
  refuses('token', () => lua.render(730, {}, {}, '1")\nload("x")\n--'));
  refuses('appid', () => lua.render('730)\nload("x")\n--'));

  // and the same script with honest values is untouched: a 64-bit manifest id, the size as a number or a string
  const ok = lua.render(730, { 731: KEY }, { 731: { manifest: '4813426003549064298', size: '2614315776' } }, '99');
  assert.equal(lua.validate(ok).ok, true);
  assert.equal(ok.split('\n').filter((line) => /load\(/.test(line)).length, 0);
});

test('strip_line cuts a comment but never inside a quoted string', () => {
  assert.equal(lua.strip_line('addappid(730) -- why').trim(), 'addappid(730)');
  assert.equal(lua.strip_line('seteticketurl("a--b")').trim(), 'seteticketurl("a--b")');
  assert.equal(lua.strip_line("addtoken(730, 'x--y')").trim(), "addtoken(730, 'x--y')");
});
