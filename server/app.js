import fs from 'node:fs';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { previewHead } from './preview.js';

const MAX_BODY = 16 * 1024;
// Largest decoded payload accepted. Mirrors the app's own decode limit, so
// nothing the app can encode is refused, and bounds the work of each page view.
const MAX_DECODED_BYTES = 1 << 20;
const HOUR = 3600e3;
const ORIGIN = 'https://spintracker.buoyantpass.com';
const AASA = '.well-known/apple-app-site-association';
const MIME = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};
const PUBLIC_5M = 'public, max-age=300';

// base64url -> raw deflate -> JSON, the way the page decodes it. Returns the
// object when it is a v1 setlist, otherwise null.
function decode(payload) {
  if (!/^[A-Za-z0-9_-]+$/.test(payload)) return null;
  try {
    const obj = JSON.parse(inflateRawSync(Buffer.from(payload, 'base64url'), { maxOutputLength: MAX_DECODED_BYTES }).toString('utf8'));
    return obj && obj.v === 1 && Array.isArray(obj.t) ? obj : null;
  } catch {
    return null;
  }
}

export function createHandler({ store, staticRoot, now, uploadsPerHour = 30 }) {
  const uploads = new Map();

  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, headers);
    res.end(body);
  };
  const plain = (res, status, text = '') =>
    send(res, status, text, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });

  function rateLimited(ip) {
    const cutoff = now() - HOUR;
    const recent = (uploads.get(ip) ?? []).filter((x) => x > cutoff);
    if (recent.length >= uploadsPerHour) {
      uploads.set(ip, recent);
      return true;
    }
    recent.push(now());
    uploads.set(ip, recent);
    return false;
  }

  function readBody(req, cb) {
    const chunks = [];
    let size = 0;
    let over = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) over = true;
      else chunks.push(c);
    });
    req.on('end', () => cb(over, Buffer.concat(chunks).toString('utf8')));
  }

  function upload(req, res) {
    const ip = req.headers['cf-connecting-ip'] || req.socket.remoteAddress || 'unknown';
    readBody(req, (over, body) => {
      if (over) return plain(res, 413, 'too large');
      if (rateLimited(ip)) return plain(res, 429, 'slow down');
      const payload = body.trim();
      if (!decode(payload)) return plain(res, 400, 'bad payload');
      const { code, deleteToken, expiresAt } = store.put(payload);
      send(res, 201, JSON.stringify({ code, url: `${ORIGIN}/r/${code}`, expiresAt, deleteToken }), {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      });
    });
  }

  function readFile(rel) {
    try {
      return fs.readFileSync(path.join(staticRoot, rel));
    } catch {
      return null;
    }
  }

  function indexPage(res, { preview, cache }) {
    const file = readFile('index.html');
    if (!file) return plain(res, 404);
    let body = file;
    if (preview) {
      const s = file.toString('utf8');
      const a = s.indexOf('<!--preview:start-->');
      const b = s.indexOf('<!--preview:end-->');
      if (a >= 0 && b > a) {
        body = Buffer.from(
          s.slice(0, a + '<!--preview:start-->'.length) + '\n    ' + preview + '\n    ' + s.slice(b),
        );
      }
    }
    send(res, 200, body, { 'content-type': 'text/html; charset=utf-8', 'cache-control': cache });
  }

  function staticFile(res, rel, type) {
    const file = readFile(rel);
    if (!file) return plain(res, 404);
    send(res, 200, file, { 'content-type': type, 'cache-control': PUBLIC_5M });
  }

  return (req, res) => {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    } catch {
      return plain(res, 404);
    }
    if (pathname.includes('..') || pathname.includes('\0') || pathname.includes('\\')) return plain(res, 404);
    const method = req.method;

    if (pathname === '/healthz') return method === 'GET' ? plain(res, 200, 'ok') : plain(res, 404);

    if (pathname === '/api/r') return method === 'POST' ? upload(req, res) : plain(res, 404);

    let m = pathname.match(/^\/api\/r\/([^/]+)$/);
    if (m) {
      const code = m[1];
      if (method === 'GET') {
        const r = store.get(code);
        if (r.status === 'ok') {
          return send(res, 200, r.payload, {
            'content-type': 'text/plain; charset=utf-8',
            'cache-control': 'no-store',
          });
        }
        return plain(res, r.status === 'gone' ? 410 : 404);
      }
      if (method === 'DELETE') {
        const auth = req.headers.authorization ?? '';
        const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
        return store.revoke(code, token) ? plain(res, 204) : plain(res, 404);
      }
      return plain(res, 404);
    }

    if (method !== 'GET') return plain(res, 404);

    if (pathname === '/') return indexPage(res, { cache: 'no-cache' });

    m = pathname.match(/^\/r\/([^/]+)$/);
    if (m) {
      const r = store.get(m[1]);
      const payload = r.status === 'ok' ? decode(r.payload) : null;
      const head = payload ? previewHead(payload, `${ORIGIN}/r/${m[1]}`) : '';
      return indexPage(res, { preview: head, cache: 'no-store' });
    }

    if (pathname === '/app.js' || pathname === '/styles.css') {
      return staticFile(res, pathname.slice(1), MIME[path.extname(pathname)]);
    }
    if (pathname === `/${AASA}`) return staticFile(res, AASA, 'application/json');
    m = pathname.match(/^\/assets\/([^/]+)$/);
    if (m && !m[1].startsWith('.') && MIME[path.extname(m[1]).toLowerCase()]) {
      return staticFile(res, `assets/${m[1]}`, MIME[path.extname(m[1]).toLowerCase()]);
    }
    return plain(res, 404);
  };
}
