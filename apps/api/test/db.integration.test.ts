// Runs against a real Postgres. Each run creates a throwaway database, runs
// the migrations twice, connects as a least-privilege login role exactly as the
// API does in production, and checks what that role can and cannot do.
import { beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { createDatabase, type Database } from '../src/db.ts';
import { baseline, createTestDatabase, SCHEMA_OWNER, SCHEMA_VERSION, type TestDatabase } from './helpers/database.ts';
import { must } from './helpers/must.ts';

// The version the migrations declare, so tests don't need editing on every change.
const VERSION = SCHEMA_VERSION;

let t: TestDatabase;
let owner: pg.Client; // the schema owner, connected to the test database
let api: pg.Client; // the API's login role
let database: Database;

beforeAll(async () => {
  t = await createTestDatabase();
  ({ owner, api, database } = t);
  return async () => {
    await t.close();
  };
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
  it('takes the baseline again without error (how older databases adopt it) and records its version', async () => {
    await owner.query(`SET ROLE ${SCHEMA_OWNER}`);
    await owner.query('BEGIN');
    await owner.query(baseline);
    await owner.query('COMMIT');
    await owner.query('RESET ROLE');
    const { rows } = await owner.query('SELECT version FROM app.schema_meta');
    expect(VERSION).toBeGreaterThan(0);
    expect(rows).toEqual([{ version: VERSION }]);
  });

  it('turns on and forces row-level security on every table in app', async () => {
    // Guards future tables too: forgetting RLS on a new table fails this test.
    const { rows } = await owner.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(`
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
                has_table_privilege($1, 'app.schema_meta', 'SELECT') AS sel`,
        [role],
      );
      expect(rows[0], role).toEqual({ usage: false, sel: false });
    }
  });
});

describe('the API login role', () => {
  it('can read what it is granted', async () => {
    expect(await database.ping()).toEqual({ schemaVersion: VERSION });
  });

  it('is not a superuser, cannot bypass RLS, create roles or databases', async () => {
    const { rows } = await api.query(
      'SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname = current_user',
    );
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
    const { rows } = await owner.query<{ name: string }>('SELECT current_user AS name');
    expect(await refused(`SET ROLE ${must(rows[0]).name}`)).toBe('42501');
  });
});

describe('withUser', () => {
  it('sets the identity only inside its own transaction', async () => {
    const id = '00000000-0000-4000-8000-000000000001';
    const inside = await database.withUser(
      id,
      async q => (await q.query<{ id: string | null }>('SELECT app.current_user_id() AS id')).rows[0]?.id,
    );
    expect(inside).toBe(id);
    // The same pooled connection, next transaction: identity must be gone.
    const after = await database.withUser(
      null,
      async q => (await q.query<{ id: string | null }>('SELECT app.current_user_id() AS id')).rows[0]?.id,
    );
    expect(after).toBeNull();
  });

  it('rolls back everything when the work fails', async () => {
    await expect(
      database.withUser(null, async q => {
        await q.query('SELECT 1');
        throw new Error('fail midway');
      }),
    ).rejects.toThrow('fail midway');
    // The connection is still usable afterwards (not left mid-transaction).
    expect(await database.ping()).toEqual({ schemaVersion: VERSION });
  });
});

describe('the startup check of the database account', () => {
  it('passes for the restricted API role', async () => {
    await expect(database.assertRestricted()).resolves.toBeUndefined();
  });

  it('refuses an owner or superuser login, which would silently skip every privacy rule', async () => {
    const asOwner = createDatabase(t.ownerUrl);
    try {
      await expect(asOwner.assertRestricted()).rejects.toThrow(/superuser|bypass|owns/);
    } finally {
      await asOwner.close();
    }
  });
});

describe('a connection that dies mid-transaction', () => {
  it('is not handed to the next request', async () => {
    // Kill this transaction's server process from outside, as a database
    // restart or network drop would.
    await expect(
      database.withUser(null, async q => {
        const pid = (await q.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
        await owner.query('SELECT pg_terminate_backend($1)', [pid]);
        await q.query('SELECT 1');
      }),
    ).rejects.toThrow();
    // Every following request must get a working connection (the pool holds up to 5).
    for (let i = 0; i < 6; i++) {
      expect(
        await database.withUser(null, async q => (await q.query<{ ok: number }>('SELECT 1 AS ok')).rows[0]?.ok),
      ).toBe(1);
    }
  });
});
