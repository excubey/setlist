import http from 'node:http';
import { openStore } from './store.js';
import { createHandler } from './app.js';

const port = Number(process.env.PORT ?? 8080);
const dbPath = process.env.DB_PATH ?? '/data/links.db';
const staticRoot = process.env.STATIC_ROOT ?? '/site';

const store = openStore(dbPath, Date.now);
const handler = createHandler({ store, staticRoot, now: Date.now });
// Hourly: expire stored links.
setInterval(() => store.sweep(), 3600e3).unref();
// Every 10 minutes: let the rate limiter forget uploader IPs idle for over an
// hour, so none is held much past 70 minutes after its last upload.
setInterval(() => handler.sweepLimiter(), 600e3).unref();
store.sweep();

// No request logger on purpose: nothing records which setlist was uploaded or viewed.
http.createServer(handler).listen(port);
