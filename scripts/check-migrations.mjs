#!/usr/bin/env node
// Checks the database migrations (db/migrations/README.md) before they ship:
//   1. each file passes the lint (no data-losing change without a reason);
//   2. no migration that already shipped (in --base) was edited or removed;
//   3. with CHECK_DATABASE_ADMIN_URL set, the upgrade path ends exactly where
//      a fresh install does: one database gets --base's schema and then these
//      migrations, another gets these migrations only, and their full schema
//      dumps (tables, constraints, policies, grants, functions) must match.
//
//   node scripts/check-migrations.mjs --base <commit>
//   PG_DUMP sets the pg_dump command (it must match the server's version).
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { checksum, lintMigration, migrate, readMigrations } from '../apps/api/src/migrations.ts';

const DIR = 'db/migrations';
const OWNER = 'graphinity_schema_owner';
const args = process.argv.slice(2);
const base = args[args.indexOf('--base') + 1] ?? null;
if (args.includes('--base') && !base) throw new Error('--base needs a commit');

const files = readMigrations(fileURLToPath(new URL(`../${DIR}`, import.meta.url)));
const problems = files.flatMap(lintMigration);

const git = (...a) =>
  execFileSync('git', a, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
// The release being upgraded from may predate migrations (no folder yet).
const listShipped = () => {
  try {
    return git('ls-tree', '--name-only', `${base}:${DIR}`)
      .split('\n')
      .filter(f => f.endsWith('.sql'));
  } catch {
    return [];
  }
};
const shipped = base ? listShipped() : [];
const hadMigrations = shipped.length > 0;
for (const f of shipped) {
  const now = files.find(m => m.file === f);
  if (!now) problems.push(`${f} was removed after it shipped. Migrations are never removed.`);
  else if (now.sql !== git('show', `${base}:${DIR}/${f}`))
    problems.push(`${f} was edited after it shipped. Put the change in a new migration instead.`);
}

for (const p of problems) console.error(p);
if (problems.length) process.exit(1);
console.log(
  `${files.length} migrations pass the lint${base ? `, and none that shipped in ${base.slice(0, 7)} changed` : ''}`,
);

const adminUrl = process.env.CHECK_DATABASE_ADMIN_URL;
if (!adminUrl) process.exit(0);
if (!base) throw new Error('the upgrade check needs --base: the release to upgrade from');

const urlFor = name => {
  const u = new URL(adminUrl);
  u.pathname = `/${name}`;
  return u.toString();
};
const admin = new pg.Client({ connectionString: adminUrl });
await admin.connect();
// Roles shaped like Supabase's, as in the integration tests (apps/api/test/helpers/database.ts).
await admin.query(`DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_api') THEN
    CREATE ROLE app_api NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${OWNER}') THEN
    CREATE ROLE ${OWNER} NOLOGIN NOSUPERUSER BYPASSRLS CREATEROLE;
  END IF;
END $$`);
await admin.query(`GRANT app_api TO ${OWNER} WITH INHERIT FALSE, SET FALSE`);

const suffix = randomBytes(4).toString('hex');
const names = { fresh: `graphinity_fresh_${suffix}`, upgraded: `graphinity_upgraded_${suffix}` };

async function prepare(name) {
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.query(`GRANT CREATE, CONNECT ON DATABASE ${name} TO ${OWNER}`);
  const c = new pg.Client({ connectionString: urlFor(name) });
  await c.connect();
  await c.query('CREATE SCHEMA IF NOT EXISTS extensions');
  await c.query('CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions');
  await c.query(`GRANT USAGE ON SCHEMA extensions TO ${OWNER}`);
  await c.query(`SET ROLE ${OWNER}`);
  return c;
}

const dump = name => {
  const out = execFileSync('sh', ['-c', `${process.env.PG_DUMP ?? 'pg_dump'} --schema-only "$0"`, urlFor(name)], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  // \restrict carries a random key per dump; comments name the database.
  return out
    .split('\n')
    .filter(l => !/^\\(un)?restrict /.test(l) && !l.startsWith('--'))
    .join('\n');
};

let failed = false;
try {
  const fresh = await prepare(names.fresh);
  await migrate(fresh, files);
  await fresh.end();

  const upgraded = await prepare(names.upgraded);
  if (hadMigrations) {
    // The last release's migrations, exactly as they shipped.
    const old = shipped.map((file, i) => {
      const sql = git('show', `${base}:${DIR}/${file}`);
      return { version: i + 1, file, sql, checksum: checksum(sql) };
    });
    await migrate(upgraded, old);
  } else {
    // Before migrations existed: the hand-applied schema file, as on the live project.
    await upgraded.query(git('show', `${base}:db/schema.sql`));
  }
  const ran = await migrate(upgraded, files);
  await upgraded.end();
  console.log(`upgrade from ${base.slice(0, 7)} ran ${ran.map(m => m.file).join(', ') || 'nothing new'}`);

  const [a, b] = [dump(names.fresh), dump(names.upgraded)];
  if (a !== b) {
    failed = true;
    const left = a.split('\n');
    const right = b.split('\n');
    const at = left.findIndex((l, i) => l !== right[i]);
    console.error(`An upgraded database differs from a fresh one, first at line ${at + 1} of the schema dump:`);
    console.error(`  fresh:    ${left[at] ?? '(end)'}\n  upgraded: ${right[at] ?? '(end)'}`);
  } else console.log('an upgraded database matches a fresh one exactly');
} finally {
  for (const name of Object.values(names)) await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.end();
}
process.exit(failed ? 1 : 0);
