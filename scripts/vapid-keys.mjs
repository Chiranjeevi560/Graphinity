// Makes a web push key pair and adds it to an env file, without printing
// the private key. Prints only the public key (public by design).
//
//   node scripts/vapid-keys.mjs .local/api.env
import { createECDH } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { privateKeyText } from '../apps/api/src/push.ts';

const file = process.argv[2];
if (!file) { console.error('Usage: node scripts/vapid-keys.mjs <env file>'); process.exit(2); }
if (/^VAPID_PRIVATE_KEY=/m.test(readFileSync(file, 'utf8'))) {
  console.error(`${file} already has VAPID keys; not replacing them (every browser would have to subscribe again).`);
  process.exit(1);
}
const ecdh = createECDH('prime256v1');
ecdh.generateKeys();
appendFileSync(file, `VAPID_PUBLIC_KEY=${ecdh.getPublicKey().toString('base64url')}\nVAPID_PRIVATE_KEY=${privateKeyText(ecdh)}\n`);
console.log(`Added a web push key pair to ${file}. Public key: ${ecdh.getPublicKey().toString('base64url')}`);
