import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomInt, createHash } from 'node:crypto';

const THIRTY_DAYS = 30 * 864e5;
const HOUR = 3600e3;
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

export const hashToken = (token) => createHash('sha256').update(token).digest('hex');

function newCode() {
  let code = '';
  for (let i = 0; i < 7; i++) code += ALPHABET[randomInt(36)];
  return code;
}

export function openStore(path, now, { busyTimeoutMs = 0 } = {}) {
  const db = new DatabaseSync(path);
  // PRAGMA rather than the constructor's timeout option: it works on every Node the store supports.
  if (busyTimeoutMs) db.exec(`PRAGMA busy_timeout = ${Number(busyTimeoutMs)}`);
  // Zero deleted payloads instead of leaving them in free pages.
  db.exec('PRAGMA secure_delete = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS links(
      code TEXT PRIMARY KEY, payload TEXT NOT NULL,
      token_hash TEXT NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS gone(
      code TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
  `);
  const insert = db.prepare('INSERT INTO links(code, payload, token_hash, expires_at) VALUES (?, ?, ?, ?)');
  const selectLink = db.prepare('SELECT payload, token_hash, expires_at FROM links WHERE code = ?');
  const selectGone = db.prepare('SELECT 1 AS x FROM gone WHERE code = ?');
  const deleteLink = db.prepare('DELETE FROM links WHERE code = ?');
  const insertGone = db.prepare('INSERT OR REPLACE INTO gone(code, expires_at) VALUES (?, ?)');
  const sweepLinks = db.prepare('DELETE FROM links WHERE expires_at < ?');
  const sweepGone = db.prepare('DELETE FROM gone WHERE expires_at < ?');

  return {
    put(payload) {
      const deleteToken = randomBytes(32).toString('base64url');
      // Floored to the hour so an expiry cannot be joined to an upload time to the millisecond.
      const expiresAt = Math.floor((now() + THIRTY_DAYS) / HOUR) * HOUR;
      for (;;) {
        const code = newCode();
        if (selectLink.get(code) || selectGone.get(code)) continue;
        try {
          insert.run(code, payload, hashToken(deleteToken), expiresAt);
        } catch (e) {
          if (/UNIQUE|constraint/i.test(String(e.message))) continue;
          throw e;
        }
        return { code, deleteToken, expiresAt };
      }
    },
    get(code) {
      const row = selectLink.get(code);
      if (row) {
        return row.expires_at >= now() ? { status: 'ok', payload: row.payload } : { status: 'gone' };
      }
      const g = selectGone.get(code);
      return g ? { status: 'gone' } : { status: 'missing' };
    },
    revoke(code, token) {
      const row = selectLink.get(code);
      if (!row || row.expires_at < now() || typeof token !== 'string' || !token) return false;
      if (hashToken(token) !== row.token_hash) return false;
      deleteLink.run(code);
      insertGone.run(code, row.expires_at);
      return true;
    },
    // Operator-only: removes a live code without its delete token. The HTTP
    // DELETE path never calls this; it goes through revoke().
    remove(code) {
      const row = selectLink.get(code);
      if (!row || row.expires_at < now()) return false;
      deleteLink.run(code);
      insertGone.run(code, row.expires_at);
      return true;
    },
    close() {
      db.close();
    },
    sweep() {
      const n = now();
      sweepLinks.run(n);
      sweepGone.run(n);
    },
  };
}
