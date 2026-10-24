#!/usr/bin/env node
// Starts the API for the browser tests (playwright.config.ts) on a database
// made fresh for this run: dropped, created, migrated by the same runner as
// every environment, as a schema owner shaped like Supabase's `postgres`,
// with its own restricted login and a new random password. Then runs the
// API with that login, so nothing a test writes outlives the run.
//
// Playwright starts its servers before its global setup, so this is where
// the database is prepared.
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { migrate, readMigrations } from '../apps/api/src/migrations.ts';
import { adminUrl, E2E_DATABASE, e2eUrl } from '../apps/web/e2e/database.ts';

const OWNER = 'graphinity_schema_owner';
const LOGIN = 'graphinity_e2e_api';

// Locally, the database server may not be running yet (CI has its own).
if (!process.env.CI) execFileSync('sh', ['scripts/db.sh', 'start'], { stdio: ['ignore', 'ignore', 'inherit'] });

const admin = new pg.Client({ connectionString: adminUrl() });
await admin.connect();
const password = randomBytes(18).toString('hex');
try {
  await admin.query(`DROP DATABASE IF EXISTS ${E2E_DATABASE} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${E2E_DATABASE}`);
  await admin.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_api') THEN
      CREATE ROLE app_api NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${OWNER}') THEN
      CREATE ROLE ${OWNER} NOLOGIN NOSUPERUSER BYPASSRLS CREATEROLE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${LOGIN}') THEN
      CREATE ROLE ${LOGIN} LOGIN IN ROLE app_api;
    END IF;
  END $$`);
  await admin.query(`GRANT app_api TO ${OWNER} WITH INHERIT FALSE, SET FALSE`);
  // Sent as a parameter-free statement with a generated hex value: nothing to escape.
  await admin.query(`ALTER ROLE ${LOGIN} LOGIN PASSWORD '${password}'`);
  await admin.query(`GRANT CREATE, CONNECT ON DATABASE ${E2E_DATABASE} TO ${OWNER}`);
  await admin.query(`GRANT CONNECT ON DATABASE ${E2E_DATABASE} TO ${LOGIN}`);
} finally {
  await admin.end();
}

const db = new pg.Client({ connectionString: e2eUrl() });
await db.connect();
try {
  await db.query('CREATE SCHEMA IF NOT EXISTS extensions');
  await db.query('SET client_min_messages = warning');
  await db.query('CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions');
  await db.query(`GRANT USAGE ON SCHEMA extensions TO ${OWNER}`);
  await db.query(`SET ROLE ${OWNER}`);
  const ran = await migrate(db, readMigrations('db/migrations'));
  console.log(`e2e database ${E2E_DATABASE}: fresh, ${ran.length} migrations applied`);
} finally {
  await db.end();
}

// Variables set here win over the env file (Node's --env-file never overrides).
const api = spawn('node', ['--env-file=.local/api.env', 'apps/api/src/main.ts'], {
  stdio: 'inherit',
  env: { ...process.env, DATABASE_URL: e2eUrl({ name: LOGIN, password }) },
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => api.kill(signal));
api.on('exit', code => process.exit(code ?? 1));
