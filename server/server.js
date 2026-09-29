import http from 'node:http';
import { openStore } from './store.js';
import { createHandler } from './app.js';

const port = Number(process.env.PORT ?? 8080);
const dbPath = process.env.DB_PATH ?? '/data/links.db';
const staticRoot = process.env.STATIC_ROOT ?? '/site';

const store = openStore(dbPath, Date.now);
const handler = createHandler({ store, staticRoot, now: Date.now });
// Hourly: expire stored links, and let the rate limiter forget idle uploader IPs.
setInterval(() => {
  store.sweep();
  handler.sweepLimiter();
}, 3600e3).unref();
store.sweep();

// No request logger on purpose: nothing records which setlist was uploaded or viewed.
http.createServer(handler).listen(port);
