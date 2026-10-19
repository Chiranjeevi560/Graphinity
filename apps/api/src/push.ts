// Web push without a library: messages are encrypted for the browser
// (RFC 8291, aes128gcm) and signed by us (VAPID, RFC 8292, with jose,
// which we already use). Checked against RFC 8291's worked example.
import { createCipheriv, createECDH, hkdfSync, randomBytes, type ECDH } from 'node:crypto';
import { importJWK, SignJWT } from 'jose';

const b64url = (b: Buffer) => b.toString('base64url');
const fromB64url = (s: string) => Buffer.from(s, 'base64url');

/**
 * Encrypts one push message for a browser. `salt` and `senderPrivateKey`
 * exist only so a test can reproduce RFC 8291's example; real messages
 * use fresh random ones every time.
 */
export function encryptPush(
  plaintext: Buffer,
  receiverPublicKey: Buffer,
  authSecret: Buffer,
  fixed: { salt?: Buffer; senderPrivateKey?: Buffer } = {},
): Buffer {
  const ecdh = createECDH('prime256v1');
  if (fixed.senderPrivateKey) ecdh.setPrivateKey(fixed.senderPrivateKey);
  else ecdh.generateKeys();
  const senderPublicKey = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(receiverPublicKey);
  const salt = fixed.salt ?? randomBytes(16);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), receiverPublicKey, senderPublicKey]);
  const ikm = Buffer.from(hkdfSync('sha256', shared, authSecret, keyInfo, 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  // One record: the message, then the 0x02 delimiter that marks the last record.
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([
    cipher.update(Buffer.concat([plaintext, Buffer.from([2])])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header.writeUInt8(senderPublicKey.length, 20);
  return Buffer.concat([header, senderPublicKey, body]);
}

/**
 * A P-256 private key as 43 base64url characters. Node returns it without
 * leading zero bytes (31 bytes, 42 characters, about one key in 256),
 * which push services and our config refuse: pad it to its full 32 bytes.
 */
export function privateKeyText(ecdh: ECDH): string {
  const key = ecdh.getPrivateKey();
  return Buffer.concat([Buffer.alloc(32 - key.length), key]).toString('base64url');
}

export interface VapidKeys {
  /** Uncompressed P-256 public key, base64url (65 bytes). Given to browsers. */
  publicKey: string;
  /** The private scalar, base64url (32 bytes). A secret. */
  privateKey: string;
  /** Who to contact about our pushes: an https: or mailto: address. */
  subject: string;
}

/** The Authorization header that proves a push comes from us (RFC 8292). */
export async function vapidHeader(endpoint: string, keys: VapidKeys, nowSeconds: number): Promise<string> {
  const pub = fromB64url(keys.publicKey);
  const key = await importJWK(
    {
      kty: 'EC',
      crv: 'P-256',
      x: b64url(pub.subarray(1, 33)),
      y: b64url(pub.subarray(33, 65)),
      d: keys.privateKey,
    },
    'ES256',
  );
  const jwt = await new SignJWT({ sub: keys.subject })
    .setProtectedHeader({ typ: 'JWT', alg: 'ES256' })
    .setAudience(new URL(endpoint).origin)
    // At most 24 hours, per RFC 8292; 12 leaves room for clock drift.
    .setExpirationTime(nowSeconds + 12 * 3600)
    .sign(key);
  return `vapid t=${jwt}, k=${keys.publicKey}`;
}

/**
 * Push services we send to. The server POSTs to whatever address a
 * browser registered, so anything else (an internal address, someone's
 * server) is refused: otherwise the API could be made to call it.
 */
export function isPushService(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.port !== '' || url.username || url.password) return false;
  const host = url.hostname;
  return (
    host === 'fcm.googleapis.com' ||
    host === 'updates.push.services.mozilla.com' ||
    host === 'web.push.apple.com' ||
    host.endsWith('.push.apple.com') ||
    host.endsWith('.notify.windows.com')
  );
}
