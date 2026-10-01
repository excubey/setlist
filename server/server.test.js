import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from './store.js';
import { createHandler } from './app.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DAY = 864e5;
const enc = (obj) => zlib.deflateRawSync(JSON.stringify(obj)).toString('base64url');
const base = { v: 1, t: [{ n: 'Titanium', a: 'David Guetta' }] };

let t, store, server, origin;

beforeEach(async () => {
  t = 1_800_000_000_000;
  store = openStore(':memory:', () => t);
  server = http.createServer(createHandler({ store, staticRoot: root, now: () => t }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${server.address().port}`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});

async function upload(payload, headers = {}) {
  const res = await fetch(`${origin}/api/r`, { method: 'POST', body: payload, headers });
  return res;
}
async function uploadOK(obj) {
  const payload = enc(obj);
  const res = await upload(payload);
  assert.equal(res.status, 201);
  return { payload, ...(await res.json()) };
}

test('upload returns a 7-char code and a token', async () => {
  const res = await upload(enc(base));
  assert.equal(res.status, 201);
  const j = await res.json();
  assert.match(j.code, /^[a-z0-9]{7}$/);
  assert.match(j.deleteToken, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(j.expiresAt, Math.floor((t + 30 * DAY) / 3600e3) * 3600e3);
  assert.ok(j.expiresAt <= t + 30 * DAY && j.expiresAt > t + 30 * DAY - 3600e3);
});

test('fetch returns the exact payload', async () => {
  const u = await uploadOK(base);
  const res = await fetch(`${origin}/api/r/${u.code}`);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), u.payload);
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

test('expired reads 410', async () => {
  const u = await uploadOK(base);
  t += 30 * DAY + 1;
  assert.equal((await fetch(`${origin}/api/r/${u.code}`)).status, 410);
});

test('unknown code reads 404', async () => {
  assert.equal((await fetch(`${origin}/api/r/zzzzzzz`)).status, 404);
});

test('revoke with the token', async () => {
  const u = await uploadOK(base);
  const d = await fetch(`${origin}/api/r/${u.code}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${u.deleteToken}` },
  });
  assert.equal(d.status, 204);
  assert.equal((await fetch(`${origin}/api/r/${u.code}`)).status, 410);
});

test('revoke with a wrong or no token reads 404 and keeps the link', async () => {
  const u = await uploadOK(base);
  const wrong = await fetch(`${origin}/api/r/${u.code}`, {
    method: 'DELETE',
    headers: { authorization: 'Bearer nope' },
  });
  const none = await fetch(`${origin}/api/r/${u.code}`, { method: 'DELETE' });
  assert.equal(wrong.status, 404);
  assert.equal(none.status, 404);
  assert.equal((await fetch(`${origin}/api/r/${u.code}`)).status, 200);
});

test('sweep clears tombstones after expiry', async () => {
  const u = await uploadOK(base);
  await fetch(`${origin}/api/r/${u.code}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${u.deleteToken}` },
  });
  t += 30 * DAY + 1;
  store.sweep();
  assert.equal((await fetch(`${origin}/api/r/${u.code}`)).status, 404);
});

test('oversized body is 413', async () => {
  const res = await upload('a'.repeat(16 * 1024 + 1));
  assert.equal(res.status, 413);
});

test('malformed payloads are 400', async () => {
  const bad = [
    'not base64!',
    Buffer.from('plain bytes, not deflate at all').toString('base64url'),
    enc({ v: 2, t: [] }),
    enc({ v: 1 }),
  ];
  for (const p of bad) assert.equal((await upload(p)).status, 400, p);
});

test('31st upload in an hour is 429', async () => {
  const h = { 'CF-Connecting-IP': '1.2.3.4' };
  for (let i = 0; i < 30; i++) assert.equal((await upload(enc(base), h)).status, 201);
  assert.equal((await upload(enc(base), h)).status, 429);
  assert.equal((await upload(enc(base), { 'CF-Connecting-IP': '5.6.7.8' })).status, 201);
  t += 3600e3;
  assert.equal((await upload(enc(base), h)).status, 201);
});

test('root serves index.html untouched', async () => {
  const res = await fetch(`${origin}/`);
  assert.equal(res.status, 200);
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), fs.readFileSync(path.join(root, 'index.html')));
  assert.equal(res.headers.get('cache-control'), 'no-cache');
});

const tracks3 = [{ n: 'A', a: 'x' }, { n: 'B', a: 'y' }, { n: 'C', a: 'z' }];

test('short page carries the preview', async () => {
  const u = await uploadOK({ v: 1, c: 'Rhythm Ride', i: 'Maya', s: 'Ride Studio', d: '2026-09-29', t: tracks3 });
  const res = await fetch(`${origin}/r/${u.code}`);
  const body = await res.text();
  assert.equal(res.status, 200);
  assert.ok(body.includes('<title>Rhythm Ride</title>'));
  assert.ok(body.includes('og:title" content="Rhythm Ride"'));
  assert.ok(body.includes('og:description" content="3 tracks · Maya · Ride Studio · 2026-09-29"'));
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.ok(body.includes(`og:image" content="https://spintracker.buoyantpass.com/assets/icon-512.png"`));
  assert.ok(body.includes(`twitter:image" content="https://spintracker.buoyantpass.com/assets/icon-512.png"`));
  assert.ok(body.includes('twitter:card" content="summary"'));
});

test('the preview icon is served as a cacheable png', async () => {
  const res = await fetch(`${origin}/assets/icon-512.png`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.equal(res.headers.get('cache-control'), 'public, max-age=300');
});

test('assets serve svg as image/svg+xml', async () => {
  const res = await fetch(`${origin}/assets/app-store-qr.svg`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/svg+xml');
});

test('preview falls back without a class name', async () => {
  const u = await uploadOK(base);
  const body = await (await fetch(`${origin}/r/${u.code}`)).text();
  assert.ok(body.includes('<title>A spin class setlist</title>'));
  assert.ok(body.includes('og:description" content="1 track"'));
});

test('preview escapes', async () => {
  const u = await uploadOK({ v: 1, c: '<script>&"', t: tracks3 });
  const body = await (await fetch(`${origin}/r/${u.code}`)).text();
  assert.ok(body.includes('<title>&lt;script&gt;&amp;&quot;</title>'));
  assert.ok(body.includes('og:title" content="&lt;script&gt;&amp;&quot;"'));
  assert.ok(!body.includes('<script>&'));
  assert.ok(!body.includes('<script>&"'));
});

test('expired and unknown short pages are generic', async () => {
  const index = fs.readFileSync(path.join(root, 'index.html'));
  const u = await uploadOK(base);
  t += 30 * DAY + 1;
  for (const code of [u.code, 'zzzzzzz']) {
    const res = await fetch(`${origin}/r/${code}`);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), index);
  }
});

test('static caching', async () => {
  for (const p of ['/app.js', '/.well-known/apple-app-site-association']) {
    const res = await fetch(`${origin}${p}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'public, max-age=300');
  }
});

test('AASA is JSON, byte for byte', async () => {
  const res = await fetch(`${origin}/.well-known/apple-app-site-association`);
  assert.ok(res.headers.get('content-type').startsWith('application/json'));
  assert.deepEqual(
    Buffer.from(await res.arrayBuffer()),
    fs.readFileSync(path.join(root, '.well-known/apple-app-site-association')),
  );
});

test('no path escapes the site', async () => {
  const raw = (p) =>
    new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: server.address().port, path: p }, (r) => {
        r.resume();
        resolve(r.statusCode);
      }).on('error', reject);
    });
  for (const p of ['/../server/server.js', '/server/app.js', '/fixtures/golden.txt', '/.git/config']) {
    assert.equal(await raw(p), 404, p);
  }
});

test('payload inflating past 1 MiB is 400', async () => {
  const p = enc({ v: 1, t: [], x: 'a'.repeat(1_100_000) });
  assert.ok(p.length < 16 * 1024);
  assert.equal((await upload(p)).status, 400);
});

test('payload inflating to just under 1 MiB is 201', async () => {
  const pad = 'a'.repeat((1 << 20) - JSON.stringify({ v: 1, t: [], x: '' }).length);
  const obj = { v: 1, t: [], x: pad };
  assert.equal(JSON.stringify(obj).length, 1 << 20);
  const p = enc(obj);
  assert.ok(p.length < 16 * 1024);
  assert.equal((await upload(p)).status, 201);
});

test('rate limiter forgets an IP after an hour', async () => {
  const handler = createHandler({ store, staticRoot: root, now: () => t });
  const s2 = http.createServer(handler);
  await new Promise((r) => s2.listen(0, '127.0.0.1', r));
  const o2 = `http://127.0.0.1:${s2.address().port}`;
  try {
    const res = await fetch(`${o2}/api/r`, { method: 'POST', body: enc(base), headers: { 'CF-Connecting-IP': '9.9.9.9' } });
    assert.equal(res.status, 201);
    assert.equal(handler.limiterEntryCount(), 1);
    t += 3600e3 - 1;
    handler.sweepLimiter();
    assert.equal(handler.limiterEntryCount(), 1);
    t += 2;
    handler.sweepLimiter();
    assert.equal(handler.limiterEntryCount(), 0);
  } finally {
    s2.closeAllConnections();
    await new Promise((r) => s2.close(r));
  }
});

test('store.remove tombstones a live code and refuses an unknown one', () => {
  const { code } = store.put(enc(base));
  assert.equal(store.remove(code), true);
  assert.equal(store.get(code).status, 'gone');
  assert.equal(store.remove('zzzzzzz'), false);
  assert.equal(store.get('zzzzzzz').status, 'missing');
});

test('HEAD / is 200 with no body', async () => {
  for (const p of ['/', '/healthz', '/app.js']) {
    const res = await fetch(`${origin}${p}`, { method: 'HEAD' });
    assert.equal(res.status, 200, p);
    assert.equal(await res.text(), '', p);
  }
  const u = await uploadOK(base);
  assert.equal((await fetch(`${origin}/r/${u.code}`, { method: 'HEAD' })).status, 200);
});

const film = '/assets/film-replay-metrics.mp4';
const filmBytes = () => fs.readFileSync(path.join(root, film));

test('video is served as video/mp4 with its length and range support', async () => {
  const res = await fetch(`${origin}${film}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'video/mp4');
  assert.equal(res.headers.get('accept-ranges'), 'bytes');
  assert.equal(Number(res.headers.get('content-length')), filmBytes().length);
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), filmBytes());
});

test("Safari's first probe, bytes=0-1, gets a 206 with two bytes", async () => {
  const res = await fetch(`${origin}${film}`, { headers: { range: 'bytes=0-1' } });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-range'), `bytes 0-1/${filmBytes().length}`);
  assert.equal(res.headers.get('content-length'), '2');
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), filmBytes().subarray(0, 2));
});

test('an open-ended range runs to the end of the file', async () => {
  const size = filmBytes().length;
  const res = await fetch(`${origin}${film}`, { headers: { range: 'bytes=100-' } });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-range'), `bytes 100-${size - 1}/${size}`);
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), filmBytes().subarray(100));
});

test('a suffix range returns the last bytes', async () => {
  const size = filmBytes().length;
  const res = await fetch(`${origin}${film}`, { headers: { range: 'bytes=-10' } });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-range'), `bytes ${size - 10}-${size - 1}/${size}`);
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), filmBytes().subarray(size - 10));
});

test('a range past the end is 416', async () => {
  const size = filmBytes().length;
  const res = await fetch(`${origin}${film}`, { headers: { range: `bytes=${size}-` } });
  assert.equal(res.status, 416);
  assert.equal(res.headers.get('content-range'), `bytes */${size}`);
});

test('HEAD on a video answers with its length and no body', async () => {
  const res = await fetch(`${origin}${film}`, { method: 'HEAD' });
  assert.equal(res.status, 200);
  assert.equal(Number(res.headers.get('content-length')), filmBytes().length);
  assert.equal((await res.arrayBuffer()).byteLength, 0);
});
