// A throwaway database per test file: created fresh, schema applied twice
// (it must be safe to re-run), and a least-privilege login role created
// exactly like production. Dropped afterwards.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { createDatabase, type Database } from '../../src/db.ts';

export const schema = readFileSync(new URL('../../../../db/schema.sql', import.meta.url), 'utf8');

export interface TestDatabase {
  /** Owner connection: may do anything. Use only to set up or inspect. */
  owner: pg.Client;
  /** A raw connection as the API's restricted role. */
  api: pg.Client;
  /** The app's Database wrapper, as the restricted role. */
  database: Database;
  /** Connection string for the owner (superuser locally and in CI). */
  ownerUrl: string;
  close(): Promise<void>;
}

export async function createTestDatabase(): Promise<TestDatabase> {
  const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
  // No silent skipping: a missing database is a failed run, not a passed one.
  if (!adminUrl) throw new Error('TEST_DATABASE_ADMIN_URL is not set. Run `npm run db:start` first.');

  const suffix = randomBytes(4).toString('hex');
  const dbName = `graphinity_test_${suffix}`;
  const loginRole = `graphinity_api_test_${suffix}`;
  const password = randomBytes(18).toString('hex');
  const urlFor = (name: string, user?: string, pass?: string) => {
    const u = new URL(adminUrl);
    u.pathname = `/${name}`;
    if (user) u.searchParams.set('user', user);
    if (pass) u.searchParams.set('password', pass);
    return u.toString();
  };

  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  // Supabase has these roles with broad defaults elsewhere; mimic them so the
  // schema's "never grant to them" rule is tested, not assumed.
  for (const r of ['anon', 'authenticated']) {
    await admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${r}') THEN CREATE ROLE ${r} NOLOGIN; END IF; END $$`);
  }
  await admin.query(`CREATE DATABASE ${dbName}`);
  const owner = new pg.Client({ connectionString: urlFor(dbName) });
  await owner.connect();
  await owner.query(schema);
  await owner.query(schema);
  await admin.query(`CREATE ROLE ${loginRole} LOGIN PASSWORD '${password}' IN ROLE app_api`);
  await admin.query(`GRANT CONNECT ON DATABASE ${dbName} TO ${loginRole}`);

  const loginUrl = urlFor(dbName, loginRole, password);
  const api = new pg.Client({ connectionString: loginUrl });
  await api.connect();
  const database = createDatabase(loginUrl);

  return {
    owner,
    api,
    database,
    ownerUrl: urlFor(dbName),
    async close() {
      await database.close();
      await api.end();
      await owner.end();
      await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await admin.query(`DROP ROLE IF EXISTS ${loginRole}`);
      await admin.end();
    },
  };
}
