#!/usr/bin/env node
// An encrypted copy of schema `app` (docs/RUNBOOK.md, "Backups"). Run before every remote migration:
//
//   npm run db:backup
//
// The password reaches pg_dump through its environment, never its arguments, which any process can read. The file holds
// everyone's data, so it's encrypted before it touches the disk, and only the newest few are kept: a deleted account
// must not live on in old backups for long.
//
// Sign-ins live in Supabase's `auth` schema, which Supabase owns: a restore needs them too (the runbook says how).
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { tlsProblem, isLocal } from '../apps/api/src/db-target.ts';
import { encryptToFile } from '../apps/api/src/backup-crypto.ts';

const url = process.env.BACKUP_DATABASE_URL ?? process.env.MIGRATION_DATABASE_URL;
if (!url) {
  console.error('No database: MIGRATION_DATABASE_URL (or BACKUP_DATABASE_URL) is not set.');
  process.exit(1);
}
// Never let libpq fall back to plain text: the password and the whole dump would cross the internet.
const tls = tlsProblem(url);
if (tls) {
  console.error(`The database address ${tls}`);
  process.exit(1);
}
const KEEP = Number(process.env.BACKUP_KEEP ?? 7);
const dir = process.env.BACKUP_DIR ?? join(homedir(), 'graphinity-backups');
const pgDump = (process.env.PG_DUMP ?? 'pg_dump').split(' ');

let passphrase = process.env.BACKUP_PASSPHRASE;
if (!passphrase) {
  if (!process.stdin.isTTY) {
    console.error('Set BACKUP_PASSPHRASE, or run this in a terminal to type one.');
    process.exit(1);
  }
  // Not shown as it's typed: readline echoes through this, and it stays silent once the question is printed.
  let silent = false;
  const output = new Writable({
    write(chunk, encoding, done) {
      if (!silent) process.stdout.write(chunk, encoding);
      done();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  const asked = rl.question('A passphrase for this backup (you need it to restore; keep it somewhere safe): ');
  silent = true;
  passphrase = await asked;
  process.stdout.write('\n');
  rl.close();
}
if (passphrase.length < 12) {
  console.error('Use a passphrase of at least 12 characters.');
  process.exit(1);
}

const u = new URL(url);
const socket = u.searchParams.get('host');
const env = {
  ...process.env,
  PGHOST: socket ?? u.hostname,
  PGPORT: u.port || u.searchParams.get('port') || '5432',
  PGUSER: decodeURIComponent(u.username || u.searchParams.get('user') || ''),
  PGPASSWORD: decodeURIComponent(u.password || u.searchParams.get('password') || ''),
  PGDATABASE: u.pathname.slice(1),
  PGSSLMODE: u.searchParams.get('sslmode') ?? (isLocal(url) ? 'prefer' : 'require'),
};

mkdirSync(dir, { recursive: true, mode: 0o700 });
const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 13);
const out = join(dir, `graphinity-${stamp}.dump.enc`);
const dump = spawn(pgDump[0], [...pgDump.slice(1), '--format=custom', '--schema=app', '--no-owner'], {
  env,
  stdio: ['ignore', 'pipe', 'inherit'],
});
// A missing pg_dump emits 'error', and otherwise crashes before the half-made file is removed.
const exited = new Promise(resolve => {
  dump.on('error', () => resolve(1));
  dump.on('close', resolve);
});
const encrypted = await encryptToFile(dump.stdout, out, passphrase).then(
  () => true,
  () => false,
);
const dumped = await exited;
if (dumped !== 0 || !encrypted) {
  rmSync(out, { force: true });
  console.error('The backup failed, and nothing was kept. pg_dump must be at least as new as the database.');
  process.exit(1);
}
chmodSync(out, 0o600);
const old = readdirSync(dir)
  .filter(f => /^graphinity-.*\.dump\.enc$/.test(f))
  .sort()
  .slice(0, -KEEP);
for (const f of old) rmSync(join(dir, f));
console.log(`Backed up to ${out}. Removed ${String(old.length)} older.`);
