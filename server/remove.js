// Operator takedown: node /app/remove.js <code>
// Removes a short link without its delete token. The code then reads 410
// "expired" until its original expiry. Reads DB_PATH like server.js.
// Exit codes: 0 removed, 1 no such code, 2 usage or error.
import { openStore } from './store.js';

const code = process.argv[2];
if (!code) {
  console.error('usage: node remove.js <code>');
  process.exit(2);
}
try {
  const store = openStore(process.env.DB_PATH ?? '/data/links.db', Date.now, { busyTimeoutMs: 5000 });
  const removed = store.remove(code);
  store.close();
  console.log(removed ? `removed ${code}` : `no such code ${code}`);
  process.exit(removed ? 0 : 1);
} catch (e) {
  console.error(`error: ${e.message}`);
  process.exit(2);
}
