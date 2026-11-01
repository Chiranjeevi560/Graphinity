#!/usr/bin/env node
// Restores a backup from db-backup.mjs into a NEW local database, to check it or read from it. It refuses anything but
// this computer: putting a backup over production is a decision for a person at a terminal, by the runbook's steps.
//
//   BACKUP_PASSPHRASE=… node scripts/db-restore.mjs <file.dump.enc> <new-database-name>
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { decryptToFile, isAuthenticated } from '../apps/api/src/backup-crypto.ts';
import { join } from 'node:path';

const [file, name] = process.argv.slice(2);
if (!file || !name || !/^[a-z][a-z0-9_]{0,40}$/.test(name) || name === 'graphinity') {
  console.error('Usage: node scripts/db-restore.mjs <file.dump.enc> <new-database-name>');
  process.exit(1);
}
const base = process.env.PG_BIN ?? '';
const tool = t => (base ? join(base, t) : t);
const env = {
  ...process.env,
  PGHOST: process.env.GRAPHINITY_DATA ?? join(homedir(), '.local/share/graphinity'),
  PGPORT: '54329',
  PGUSER: 'graphinity_owner',
};
const done = p => new Promise(resolve => p.on('close', resolve));
const run = async (cmd, args) => {
  if ((await done(spawn(cmd, args, { env, stdio: 'inherit' }))) !== 0) process.exit(1);
};
await run(tool('createdb'), [name]);
await run(tool('psql'), [
  '-q',
  '-d',
  name,
  '-c',
  'CREATE SCHEMA IF NOT EXISTS extensions; CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;',
]);
const fail = () => {
  console.error('The restore failed: a wrong passphrase, or a damaged or changed file.');
  process.exit(1);
};
if (isAuthenticated(file)) {
  // Decrypted in full first: the tag is only checked at the end, and pg_restore must never read unverified bytes.
  const work = mkdtempSync(join(tmpdir(), 'graphinity-restore-'));
  const plain = join(work, 'dump');
  try {
    await decryptToFile(file, plain, process.env.BACKUP_PASSPHRASE ?? '').catch(fail);
    const code = await done(
      spawn(tool('pg_restore'), ['--no-owner', '--exit-on-error', '-d', name, plain], { env, stdio: 'inherit' }),
    );
    if (code !== 0) fail();
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
} else {
  // An older backup, made before files carried a tag: nothing proves it wasn't changed.
  console.error('This backup is in the older format, without tamper protection. Restoring it anyway.');
  const dec = spawn(
    'openssl',
    ['enc', '-d', '-aes-256-cbc', '-pbkdf2', '-iter', '200000', '-pass', 'env:BACKUP_PASSPHRASE', '-in', file],
    { env, stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const restore = spawn(tool('pg_restore'), ['--no-owner', '--exit-on-error', '-d', name], {
    env,
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  dec.stdout.pipe(restore.stdin);
  const [a, b] = await Promise.all([done(dec), done(restore)]);
  if (a !== 0 || b !== 0) fail();
}
console.log(`Restored into local database ${name}.`);
