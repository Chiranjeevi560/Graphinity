// Runs against a real Postgres. Each run creates a throwaway database, applies
// the schema twice, connects as a least-privilege login role exactly as the
// API does in production, and checks what that role can and cannot do.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type Database } from '../src/db.ts';

const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
// No silent skipping: a missing database is a failed run, not a passed one.
if (!adminUrl) throw new Error('TEST_DATABASE_ADMIN_URL is not set. Run `npm run db:start` first.');

const schema = readFileSync(new URL('../../../db/schema.sql', import.meta.url), 'utf8');
const suffix = randomBytes(4).toString('hex');
const dbName = `graphinity_test_${suffix}`;
const loginRole = `graphinity_api_test_${suffix}`;
const password = randomBytes(18).toString('hex');

const admin = new pg.Client({ connectionString: adminUrl });
let owner: pg.Client; // the schema owner, connected to the test database
let api: pg.Client; // the API's login role
let database: Database;

function urlFor(name: string, user?: string, pass?: string): string {
  const u = new URL(adminUrl!);
  u.pathname = `/${name}`;
  if (user) u.searchParams.set('user', user);
  if (pass) u.searchParams.set('password', pass);
  return u.toString();
}

beforeAll(async () => {
  await admin.connect();
  // Supabase has these roles with broad defaults elsewhere; mimic them so the
  // schema's "never grant to them" rule is tested, not assumed.
  for (const r of ['anon', 'authenticated']) {
    await admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${r}') THEN CREATE ROLE ${r} NOLOGIN; END IF; END $$`);
  }
  await admin.query(`CREATE DATABASE ${dbName}`);
  owner = new pg.Client({ connectionString: urlFor(dbName) });
  await owner.connect();
  await owner.query(schema);
  await owner.query(schema); // must be safe to run twice
  await admin.query(`CREATE ROLE ${loginRole} LOGIN PASSWORD '${password}' IN ROLE app_api`);
  await admin.query(`GRANT CONNECT ON DATABASE ${dbName} TO ${loginRole}`);

  const loginUrl = urlFor(dbName, loginRole, password);
  api = new pg.Client({ connectionString: loginUrl });
  await api.connect();
  database = createDatabase(loginUrl);
});

afterAll(async () => {
  await database?.close();
  await api?.end();
  await owner?.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.query(`DROP ROLE IF EXISTS ${loginRole}`);
  await admin.end();
});

async function refused(sql: string): Promise<string> {
  try {
    await api.query(sql);
  } catch (err) {
    return (err as { code: string }).code;
  }
  throw new Error(`Expected to be refused: ${sql}`);
}

describe('schema', () => {
  it('applies a third time without error and records its version', async () => {
    await owner.query(schema);
    const { rows } = await owner.query('SELECT version FROM app.schema_meta');
    expect(rows).toEqual([{ version: 1 }]);
  });

  it('turns on and forces row-level security on every table in app', async () => {
    // Guards future tables too: forgetting RLS on a new table fails this test.
    const { rows } = await owner.query(`
      SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'app' AND c.relkind IN ('r', 'p')`);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r, r.relname).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
  });

  it('gives Supabase public roles nothing in app', async () => {
    for (const role of ['anon', 'authenticated']) {
      const { rows } = await owner.query(
        `SELECT has_schema_privilege($1, 'app', 'USAGE') AS usage,
                has_table_privilege($1, 'app.schema_meta', 'SELECT') AS sel`, [role]);
      expect(rows[0], role).toEqual({ usage: false, sel: false });
    }
  });
});

describe('the API login role', () => {
  it('can read what it is granted', async () => {
    expect(await database.ping()).toEqual({ schemaVersion: 1 });
  });

  it('is not a superuser, cannot bypass RLS, create roles or databases', async () => {
    const { rows } = await api.query(
      'SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname = current_user');
    expect(rows[0]).toEqual({ rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false });
  });

  it('cannot create tables in app or public (42501 = insufficient privilege)', async () => {
    expect(await refused('CREATE TABLE app.sneaky (id int)')).toBe('42501');
    expect(await refused('CREATE TABLE public.sneaky (id int)')).toBe('42501');
  });

  it('cannot write to tables it may only read', async () => {
    expect(await refused('UPDATE app.schema_meta SET version = 999')).toBe('42501');
    expect(await refused('DELETE FROM app.schema_meta')).toBe('42501');
  });

  it('cannot change ownership or policies', async () => {
    expect(await refused('ALTER TABLE app.schema_meta DISABLE ROW LEVEL SECURITY')).toBe('42501');
    expect(await refused('DROP POLICY schema_meta_read ON app.schema_meta')).toBe('42501');
  });

  it('cannot become the owner role', async () => {
    const { rows } = await owner.query('SELECT current_user AS name');
    expect(await refused(`SET ROLE ${rows[0].name}`)).toBe('42501');
  });
});

describe('withUser', () => {
  it('sets the identity only inside its own transaction', async () => {
    const id = '00000000-0000-4000-8000-000000000001';
    const inside = await database.withUser(id, async q => (await q.query('SELECT app.current_user_id() AS id')).rows[0]?.id);
    expect(inside).toBe(id);
    // The same pooled connection, next transaction: identity must be gone.
    const after = await database.withUser(null, async q => (await q.query('SELECT app.current_user_id() AS id')).rows[0]?.id);
    expect(after).toBeNull();
  });

  it('rolls back everything when the work fails', async () => {
    await expect(database.withUser(null, async q => {
      await q.query('SELECT 1');
      throw new Error('fail midway');
    })).rejects.toThrow('fail midway');
    // The connection is still usable afterwards (not left mid-transaction).
    expect(await database.ping()).toEqual({ schemaVersion: 1 });
  });
});
