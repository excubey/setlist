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
  assert.equal(j.expiresAt, t + 30 * DAY);
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
