// Backup encryption with authentication: AES-256-GCM with a key from scrypt. A changed byte anywhere fails the tag, so a
// tampered file never reaches pg_restore. File: magic, salt, nonce, ciphertext, 16-byte tag.
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { closeSync, createReadStream, createWriteStream, fstatSync, openSync, readSync } from 'node:fs';
import { once } from 'node:events';
import { finished } from 'node:stream/promises';

const MAGIC = Buffer.from('GRBK2\n');
const SALT = 16;
const NONCE = 12;
const TAG = 16;
const HEADER = MAGIC.length + SALT + NONCE;

const keyFrom = (passphrase: string, salt: Buffer) =>
  scryptSync(passphrase, salt, 32, { N: 2 ** 17, r: 8, p: 1, maxmem: 2 ** 28 });

/** Reads `input` to its end and writes the encrypted file at `path`. */
export async function encryptToFile(input: AsyncIterable<Uint8Array>, path: string, passphrase: string): Promise<void> {
  const salt = randomBytes(SALT);
  const nonce = randomBytes(NONCE);
  const cipher = createCipheriv('aes-256-gcm', keyFrom(passphrase, salt), nonce);
  const out = createWriteStream(path, { mode: 0o600 });
  out.write(Buffer.concat([MAGIC, salt, nonce]));
  for await (const chunk of input) {
    if (!out.write(cipher.update(chunk))) await once(out, 'drain');
  }
  out.write(cipher.final());
  out.end(cipher.getAuthTag());
  await finished(out);
}

/** The header's first bytes: whether this file is in the authenticated format. */
export function isAuthenticated(path: string): boolean {
  const fd = openSync(path, 'r');
  try {
    const head = Buffer.alloc(MAGIC.length);
    readSync(fd, head, 0, MAGIC.length, 0);
    return head.equals(MAGIC);
  } finally {
    closeSync(fd);
  }
}

/** Decrypts `path` to `target`. Rejects, leaving the caller to remove `target`, if a byte was changed. */
export async function decryptToFile(path: string, target: string, passphrase: string): Promise<void> {
  const fd = openSync(path, 'r');
  const header = Buffer.alloc(HEADER);
  const tag = Buffer.alloc(TAG);
  let size = 0;
  try {
    size = fstatSync(fd).size;
    if (size < HEADER + TAG) throw new Error('too short');
    readSync(fd, header, 0, HEADER, 0);
    readSync(fd, tag, 0, TAG, size - TAG);
  } finally {
    closeSync(fd);
  }
  const salt = header.subarray(MAGIC.length, MAGIC.length + SALT);
  const nonce = header.subarray(MAGIC.length + SALT);
  const decipher = createDecipheriv('aes-256-gcm', keyFrom(passphrase, salt), nonce, { authTagLength: TAG });
  decipher.setAuthTag(tag);
  const out = createWriteStream(target, { mode: 0o600 });
  // An empty range would make createReadStream read the whole file.
  if (size - TAG > HEADER)
    for await (const chunk of createReadStream(path, { start: HEADER, end: size - TAG - 1 }) as AsyncIterable<Buffer>) {
      if (!out.write(decipher.update(chunk))) await once(out, 'drain');
    }
  out.write(decipher.final());
  out.end();
  await finished(out);
}
