// Backups: authenticated encryption, so a changed byte never reaches pg_restore.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { decryptToFile, encryptToFile, isAuthenticated } from '../src/backup-crypto.ts';
import { isLocal, targetHost, tlsProblem } from '../src/db-target.ts';

const dir = mkdtempSync(join(tmpdir(), 'backup-test-'));
const secret = 'a long enough passphrase';
const made = async (data: Buffer, name: string) => {
  const path = join(dir, name);
  await encryptToFile(Readable.from([data.subarray(0, 10), data.subarray(10)]), path, secret);
  return path;
};

describe('a backup file', () => {
  const data = Buffer.from('the dump, in bytes '.repeat(1000));

  it('comes back exactly, and holds none of the plain text', async () => {
    const path = await made(data, 'a');
    expect(isAuthenticated(path)).toBe(true);
    expect(readFileSync(path).includes(Buffer.from('the dump'))).toBe(false);
    await decryptToFile(path, `${path}.out`, secret);
    expect(readFileSync(`${path}.out`).equals(data)).toBe(true);
  });

  it('is refused with the wrong passphrase, or with any changed byte', async () => {
    const path = await made(data, 'b');
    await expect(decryptToFile(path, `${path}.out`, 'another passphrase')).rejects.toThrow();
    const original = readFileSync(path);
    for (const at of [20, 40, 500, original.length - 1]) {
      const changed = Buffer.from(original);
      changed[at] = (changed[at] ?? 0) ^ 1;
      writeFileSync(path, changed);
      await expect(decryptToFile(path, `${path}.out`, secret)).rejects.toThrow();
    }
  }, 60_000);
});

describe('which database an address reaches', () => {
  it('goes by the host parameter, as pg does', () => {
    const url = 'postgres://u:p@localhost/db?host=prod.example.com';
    expect(targetHost(url)).toBe('prod.example.com');
    expect(isLocal(url)).toBe(false);
    expect(tlsProblem(url)).not.toBeNull();
    expect(isLocal('postgres:///db?host=/tmp/sockets')).toBe(true);
    expect(isLocal('postgres://u@localhost/db')).toBe(true);
  });
});
