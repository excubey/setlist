import http from 'node:http';
import { openStore } from './store.js';
import { createHandler } from './app.js';

const port = Number(process.env.PORT ?? 8080);
const dbPath = process.env.DB_PATH ?? '/data/links.db';
const staticRoot = process.env.STATIC_ROOT ?? '/site';

const store = openStore(dbPath, Date.now);
setInterval(() => store.sweep(), 3600e3).unref();
store.sweep();

// No request logger on purpose: nothing records which setlist was uploaded or viewed.
http.createServer(createHandler({ store, staticRoot, now: Date.now })).listen(port);
