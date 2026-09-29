// Operator takedown: node /app/remove.js <code>
// Removes a short link without its delete token. The code then reads 410
// "expired" until its original expiry. Reads DB_PATH like server.js.
import { openStore } from './store.js';

const code = process.argv[2];
if (!code) {
  console.error('usage: node remove.js <code>');
  process.exit(2);
}
const store = openStore(process.env.DB_PATH ?? '/data/links.db', Date.now);
const removed = store.remove(code);
store.close();
console.log(removed ? `removed ${code}` : `no such code ${code}`);
process.exit(removed ? 0 : 1);
