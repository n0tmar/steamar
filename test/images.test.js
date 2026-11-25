'use strict';

// The artwork cache. Every address in it comes from somewhere else - Steam's CDN, a store lookup, a row
// in the fixes table - and the file it writes is named after an id from the page, so each case here is
// a way that "fetch a picture" could be made to fetch or write something else.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'stm-app-images-'));
process.env.STEAMAR_OUT = path.join(ROOT, 'out');

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(700, 1)]);
const calls = [];
let route = () => null;

// Like the real one: a redirect is followed on its own unless the caller says it will do that by hand.
globalThis.fetch = async function stub(url, options = {}) {
  calls.push(String(url));
  const answer = route(String(url)) || new Response('', { status: 404 });
  const next = answer.status >= 300 && answer.status < 400 ? answer.headers.get('location') : null;
  if (next && options.redirect !== 'manual') return stub(new URL(next, url), options);
  return answer;
};

const images = require('../src/images');

const jpeg = () => new Response(JPEG, { status: 200, headers: { 'content-type': 'image/jpeg' } });
const html = () => new Response('<html>not found</html>'.repeat(60), { status: 200, headers: { 'content-type': 'text/html' } });
const imgcache = (kind, id) => path.join(ROOT, 'out', 'imgcache', kind, `${id}.jpg`);

test.beforeEach(() => { calls.length = 0; route = () => null; });

test('only a plain number is an app id, and nothing is fetched for anything else', async () => {
  for (const id of ['../../../config/steam', '1e3', '', '12 34', '9'.repeat(13)]) {
    assert.equal(await images.ensure('h', id), null, JSON.stringify(id));
  }
  assert.equal(await images.ensure('nope', '620'), null);
  assert.equal(await images.poster_ensure('../x', 'https://example.com/p.jpg'), null);
  assert.deepEqual(calls, []);
});

test('art is fetched once, kept on disk, and read from there afterwards', async () => {
  route = (url) => (url.includes('/10/header.jpg') ? jpeg() : null);
  const first = await images.ensure('h', '10');
  assert.deepEqual({ type: first.type, file: first.file }, { type: 'image/jpeg', file: imgcache('h', 10) });
  assert.deepEqual(fs.readFileSync(first.file), JPEG);
  const asked = calls.length;
  assert.ok(asked >= 1);

  const again = await images.ensure('h', '10');
  assert.equal(again.file, first.file);
  assert.equal(calls.length, asked, 'the second look is a file read');
});

test('a page that is not a picture, or is too small to be one, is a miss that is not asked for again', async () => {
  route = (url) => (url.includes('/20/') ? html() : null);
  assert.equal(await images.ensure('h', '20'), null);
  assert.equal(fs.existsSync(imgcache('h', 20)), false);
  const asked = calls.length;
  assert.equal(await images.ensure('h', '20'), null);
  assert.equal(calls.length, asked, 'the miss is remembered for this run');

  route = (url) => (url.includes('/21/') ? new Response(Buffer.alloc(100, 1), { status: 200, headers: { 'content-type': 'image/jpeg' } }) : null);
  assert.equal(await images.ensure('h', '21'), null, 'a hundred bytes is an error page with a picture header on it');
});

test('a redirect to plain http is never followed', async () => {
  route = (url) => (url.includes('/30/header.jpg')
    ? new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } })
    : null);
  assert.equal(await images.ensure('h', '30'), null);
  assert.ok(calls.length >= 1);
  assert.ok(calls.every((url) => url.startsWith('https://')), `every request was https: ${calls.join(' ')}`);
});

test('a redirect to another https address is followed, by hand, a few hops at most', async () => {
  route = (url) => {
    if (url.includes('/40/header.jpg')) return new Response(null, { status: 302, headers: { location: 'https://img.example.com/a.jpg' } });
    if (url === 'https://img.example.com/a.jpg') return jpeg();
    return null;
  };
  const got = await images.ensure('h', '40');
  assert.equal(got.type, 'image/jpeg');
  assert.ok(calls.includes('https://img.example.com/a.jpg'));

  let hops = 0;
  route = (url) => {
    if (!url.includes('/41/') && !url.startsWith('https://loop.example.com')) return null;
    hops += 1;
    return new Response(null, { status: 302, headers: { location: `https://loop.example.com/${hops}` } });
  };
  assert.equal(await images.ensure('h', '41'), null);
  assert.ok(hops > 0 && hops <= 2 * 4, `two addresses, each the first ask and three hops at most (${hops})`);
});

test('a body bigger than any art is dropped, whether it says so or just keeps coming', async () => {
  route = (url) => (url.includes('/50/') ? new Response(JPEG, { status: 200, headers: { 'content-type': 'image/jpeg', 'content-length': String(9 * 1024 * 1024) } }) : null);
  assert.equal(await images.ensure('h', '50'), null, 'declared too big');

  let sent = 0;
  route = (url) => {
    if (!url.includes('/51/')) return null;
    return new Response(new ReadableStream({
      pull(controller) {
        sent += 1;
        controller.enqueue(Buffer.alloc(1024 * 1024, 0xff));
        if (sent > 100) controller.close();
      },
    }), { status: 200, headers: { 'content-type': 'image/jpeg' } });
  };
  assert.equal(await images.ensure('h', '51'), null, 'never stops sending');
  assert.ok(sent < 40, `it was cut off after ${sent} chunks, not read to the end`);
  assert.equal(fs.existsSync(imgcache('h', 51)), false);
});

test('a poster that a row names with http:// is asked for over https', async () => {
  route = (url) => (url === 'https://online-fix.me/uploads/p.jpg' ? jpeg() : null);
  const got = await images.poster_ensure('60', 'http://online-fix.me/uploads/p.jpg');
  assert.equal(got.type, 'image/jpeg');
  assert.deepEqual(calls, ['https://online-fix.me/uploads/p.jpg']);
});

test('a wide picture that does not exist falls back to the header rather than a hole', async () => {
  route = (url) => (url.includes('/70/header.jpg') ? jpeg() : null);
  const got = await images.ensure('hero', '70');
  assert.equal(got.file, imgcache('hero', 70));
  assert.deepEqual(fs.readFileSync(got.file), JPEG);
});

test('a banner probe is answered from disk at the next start, unless no host answered it', async () => {
  route = (url) => (url.includes('/71/library_hero.jpg') ? jpeg() : null);
  assert.equal(await images.hero_available('71'), true);
  assert.equal(await images.hero_available('72'), false);
  route = () => { throw new TypeError('fetch failed'); };
  assert.equal(await images.hero_available('73'), false);

  // A new engine is a new process: it reads the kept answers and asks the CDN nothing for them.
  delete require.cache[require.resolve('../src/images')];
  const restarted = require('../src/images');
  calls.length = 0;
  assert.equal(await restarted.hero_available('71'), true);
  assert.equal(await restarted.hero_available('72'), false);
  assert.deepEqual(calls, []);

  route = (url) => (url.includes('/73/library_hero.jpg') ? jpeg() : null);
  assert.equal(await restarted.hero_available('73'), true, 'the probe nobody answered is asked again');
});

test('a picture from the site is fetched only in the shapes the page asks for', async () => {
  process.env.STEAMAR_SITE = 'https://site.test';
  for (const rel of ['../../config/steam.json', 'badges/../../x.png', 'frames/a b.gif', 'profile/abc.jpg', 'badge/abc.png', 'badge/../x.png', 'other/x.png', '']) {
    assert.equal(await images.site_ensure(rel), null, JSON.stringify(rel));
  }
  assert.deepEqual(calls, [], 'nothing was asked for');

  // The site has served its GIFs as application/octet-stream; the bytes are what count.
  const gif = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(700, 1)]);
  route = (url) => (url.endsWith('.gif') ? new Response(gif, { headers: { 'content-type': 'application/octet-stream' } }) : jpeg());
  const name = `${'c'.repeat(24)}.jpg`;
  assert.ok(await images.site_ensure(`profile/${name}`), 'a profile picture');
  assert.ok(await images.site_ensure('frames/heartbloom.gif'), 'a frame');
  assert.ok(await images.site_ensure(`badge/${name}`), 'a badge the console uploaded');
  assert.deepEqual(calls, [`https://site.test/v1/profile/image?f=${name}`, 'https://site.test/assets/frames/heartbloom.gif', `https://site.test/v1/badge/image?f=${name}`]);
  assert.ok(await images.site_ensure(`profile/${name}`), 'the second time');
  assert.equal(calls.length, 3, 'is read from disk');
});
