// The migration runner against a real Postgres, run as a schema owner shaped
// like Supabase's `postgres` (not a superuser, bypasses row-level security).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { checksum, LOCK_TIMEOUT, migrate, type Migration } from '../src/migrations.ts';
import { baseline, createTestDatabase, migrations, SCHEMA_OWNER, type TestDatabase } from './helpers/database.ts';

let t: TestDatabase;

beforeEach(async () => {
  t = await createTestDatabase({ migrated: false });
  await t.owner.query(`SET ROLE ${SCHEMA_OWNER}`);
});
afterEach(async () => {
  await t.owner.query('RESET ROLE');
  await t.close();
});

const next = (sql: string): Migration => {
  const version = migrations.length + 1;
  return { version, file: `${String(version).padStart(4, '0')}_test.sql`, sql, checksum: checksum(sql) };
};

const recorded = async () =>
  (
    await t.owner.query<{ version: number; checksum: string }>(
      'SELECT version, checksum FROM app.schema_migrations ORDER BY version',
    )
  ).rows;

async function failure(run: Promise<unknown>): Promise<string> {
  try {
    await run;
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error('expected the migration to be refused');
}

describe('migrations on an empty database', () => {
  it('apply every file once, in order, recording each checksum; running again changes nothing', async () => {
    const ran = await migrate(t.owner, migrations);
    expect(ran.map(m => m.version)).toEqual(migrations.map(m => m.version));
    expect(await recorded()).toEqual(migrations.map(m => ({ version: m.version, checksum: m.checksum })));
    expect(await migrate(t.owner, migrations)).toEqual([]);
    expect(await recorded()).toHaveLength(migrations.length);
  });

  it('keep the record out of the API’s reach', async () => {
    await migrate(t.owner, migrations);
    await expect(t.api.query('SELECT * FROM app.schema_migrations')).rejects.toMatchObject({ code: '42501' });
  });
});

describe('a database made before migrations', () => {
  it('adopts the baseline without losing anything already there', async () => {
    // The old way: the schema file applied by hand, no record of it.
    await t.owner.query('BEGIN');
    await t.owner.query(baseline);
    await t.owner.query('COMMIT');
    const before = await t.owner.query('SELECT slug FROM app.fields ORDER BY slug');
    expect(before.rows.length).toBeGreaterThan(0);

    await migrate(t.owner, migrations);
    expect((await t.owner.query('SELECT slug FROM app.fields ORDER BY slug')).rows).toEqual(before.rows);
    expect(await recorded()).toHaveLength(migrations.length);
  });
});

describe('the runner refuses', () => {
  it('a migration edited after it ran', async () => {
    await migrate(t.owner, migrations);
    await t.owner.query("UPDATE app.schema_migrations SET checksum = repeat('0', 64) WHERE version = 1");
    expect(await failure(migrate(t.owner, migrations))).toMatch(/0001_baseline\.sql changed after it was applied/);
  });

  it('a database newer than the code', async () => {
    await migrate(t.owner, [...migrations, next('SELECT 1')]);
    expect(await failure(migrate(t.owner, migrations))).toMatch(/which this code doesn't: it is newer/);
  });

  it('a role that cannot see past row-level security (it would lose track and run everything again)', async () => {
    await t.owner.query('RESET ROLE');
    await t.owner.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'graphinity_no_bypass') THEN
        CREATE ROLE graphinity_no_bypass NOLOGIN NOSUPERUSER NOBYPASSRLS;
      END IF; END $$`);
    await t.owner.query('SET ROLE graphinity_no_bypass');
    expect(await failure(migrate(t.owner, migrations))).toMatch(/must bypass row-level security/);
  });
});

describe('a migration that fails', () => {
  it('leaves nothing half done', async () => {
    await migrate(t.owner, migrations);
    const broken = next('CREATE TABLE app.half_done (id integer); SELECT 1 / 0;');
    expect(await failure(migrate(t.owner, [...migrations, broken]))).toContain(
      `${broken.file} failed and was rolled back: division by zero`,
    );
    expect((await t.owner.query("SELECT to_regclass('app.half_done') AS t")).rows).toEqual([{ t: null }]);
    expect(await recorded()).toHaveLength(migrations.length);
  });

  it('is recorded in the same transaction as its changes, so they land together or not at all', async () => {
    await migrate(t.owner, migrations);
    // Its changes succeed, but its record can't be written (the version is already taken).
    const clash = next(
      `CREATE TABLE app.unrecorded (id integer);
       INSERT INTO app.schema_migrations (version, file, checksum) VALUES (${String(migrations.length + 1)}, 'clash', repeat('a', 64))`,
    );
    expect(await failure(migrate(t.owner, [...migrations, clash]))).toMatch(/failed and was rolled back/);
    expect((await t.owner.query("SELECT to_regclass('app.unrecorded') AS t")).rows).toEqual([{ t: null }]);
  });

  it(
    `gives up waiting for a lock after ${LOCK_TIMEOUT} instead of stalling every request behind it`,
    { timeout: 20_000 },
    async () => {
      await migrate(t.owner, migrations);
      const holder = new pg.Client({ connectionString: t.ownerUrl });
      await holder.connect();
      try {
        await holder.query('BEGIN');
        await holder.query('LOCK TABLE app.schema_meta IN ACCESS SHARE MODE');
        const started = Date.now();
        const change = next('ALTER TABLE app.schema_meta ADD COLUMN IF NOT EXISTS lock_probe integer');
        expect(await failure(migrate(t.owner, [...migrations, change]))).toMatch(/lock timeout/);
        expect(Date.now() - started).toBeLessThan(10_000);
      } finally {
        await holder.query('ROLLBACK');
        await holder.end();
      }
      expect(await recorded()).toHaveLength(migrations.length);
    },
  );
});
