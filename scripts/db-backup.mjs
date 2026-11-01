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

const url = process.env.BACKUP_DATABASE_URL ?? process.env.MIGRATION_DATABASE_URL;
if (!url) {
  console.error('No database: MIGRATION_DATABASE_URL (or BACKUP_DATABASE_URL) is not set.');
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
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  passphrase = await rl.question('A passphrase for this backup (you need it to restore; keep it somewhere safe): ');
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
  PGSSLMODE: u.searchParams.get('sslmode') ?? 'prefer',
  BACKUP_PASSPHRASE: passphrase,
};

mkdirSync(dir, { recursive: true, mode: 0o700 });
const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 13);
const out = join(dir, `graphinity-${stamp}.dump.enc`);
const dump = spawn(pgDump[0], [...pgDump.slice(1), '--format=custom', '--schema=app', '--no-owner'], {
  env,
  stdio: ['ignore', 'pipe', 'inherit'],
});
const enc = spawn(
  'openssl',
  ['enc', '-aes-256-cbc', '-pbkdf2', '-iter', '200000', '-salt', '-pass', 'env:BACKUP_PASSPHRASE', '-out', out],
  { env, stdio: ['pipe', 'inherit', 'inherit'] },
);
dump.stdout.pipe(enc.stdin);
const done = p => new Promise(resolve => p.on('close', resolve));
const [a, b] = await Promise.all([done(dump), done(enc)]);
if (a !== 0 || b !== 0) {
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
