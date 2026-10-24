import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checksum, lintMigration, plan, readMigrations, type Migration } from '../src/migrations.ts';

let dir = '';
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = '';
});

function folder(files: Record<string, string>): string {
  dir = mkdtempSync(join(tmpdir(), 'graphinity-migrations-'));
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql);
  return dir;
}

const m = (version: number, sql = `SELECT ${String(version)}`): Migration => ({
  version,
  file: `${String(version).padStart(4, '0')}_x.sql`,
  sql,
  checksum: checksum(sql),
});

describe('readMigrations', () => {
  it('reads the files in order with their checksums, ignoring anything that isn’t SQL', () => {
    const files = readMigrations(
      folder({ '0002_second.sql': 'SELECT 2', '0001_first.sql': 'SELECT 1', 'README.md': '# notes' }),
    );
    expect(files.map(f => [f.version, f.file, f.checksum])).toEqual([
      [1, '0001_first.sql', checksum('SELECT 1')],
      [2, '0002_second.sql', checksum('SELECT 2')],
    ]);
  });

  it('refuses a gap, a repeat or a badly named file', () => {
    expect(() => readMigrations(folder({ '0001_a.sql': '', '0003_c.sql': '' }))).toThrow(
      /0003_c\.sql: expected 0002 next/,
    );
    expect(() => readMigrations(folder({ '0001_a.sql': '', '0001_b.sql': '' }))).toThrow(
      /0001_b\.sql: expected 0002 next/,
    );
    expect(() => readMigrations(folder({ '0001_Add Thing.sql': '' }))).toThrow(/name migrations like/);
  });
});

describe('plan', () => {
  const [one, two, three] = [m(1), m(2), m(3)];
  const files = [one, two, three];

  it('runs what the database hasn’t had yet', () => {
    expect(plan(files, []).map(f => f.version)).toEqual([1, 2, 3]);
    expect(
      plan(
        files,
        [one, two].map(f => ({ version: f.version, checksum: f.checksum })),
      ).map(f => f.version),
    ).toEqual([3]);
    expect(plan(files, files)).toEqual([]);
  });

  it('refuses an edited migration, a newer database and a gap in the record', () => {
    expect(() => plan(files, [{ version: 1, checksum: checksum('SELECT 99') }])).toThrow(/0001_x\.sql changed/);
    expect(() => plan(files, [...files, m(4)])).toThrow(/it is newer/);
    expect(() => plan(files, [one, three])).toThrow(/gap before 3/);
  });
});

describe('lintMigration', () => {
  const lint = (sql: string) => lintMigration({ version: 2, file: '0002_x.sql', sql });

  it('passes additive changes, and replacing a policy or function', () => {
    expect(
      lint(`ALTER TABLE app.answers ADD COLUMN IF NOT EXISTS lang text;
        CREATE INDEX IF NOT EXISTS answers_lang ON app.answers (lang);
        DROP POLICY IF EXISTS answers_read ON app.answers;
        CREATE POLICY answers_read ON app.answers FOR SELECT TO app_api USING (true);`),
    ).toEqual([]);
  });

  it('refuses each change that loses data or breaks running code, unless it says why', () => {
    for (const sql of [
      'DROP TABLE app.old',
      'ALTER TABLE app.a DROP COLUMN b',
      'TRUNCATE app.a',
      'ALTER TABLE app.a RENAME COLUMN b TO c',
      'ALTER TABLE app.a ALTER COLUMN b TYPE bigint',
      'ALTER TABLE app.a ALTER COLUMN b SET DATA TYPE bigint',
    ]) {
      expect(lint(sql), sql).toHaveLength(1);
      expect(lint(`-- contract: no release since 0007 reads b\n${sql}`), sql).toEqual([]);
    }
  });

  it('needs a real reason, and ignores the words inside comments', () => {
    expect(lint('-- contract: ok\nDROP TABLE app.old')).toHaveLength(1);
    expect(lint('-- we never DROP TABLE here\nSELECT 1')).toEqual([]);
  });

  it('refuses its own transaction and CONCURRENTLY', () => {
    expect(lint('BEGIN;\nSELECT 1;\nCOMMIT;')[0]).toMatch(/leave out BEGIN and COMMIT/);
    expect(lint('CREATE INDEX CONCURRENTLY a ON app.b (c)')[0]).toMatch(/CONCURRENTLY/);
    // A DO block's BEGIN is not a transaction.
    expect(lint('DO $$ BEGIN PERFORM 1; END $$;')).toEqual([]);
    expect(lint('DO $$\nBEGIN\n  PERFORM 1;\nEND;\n$$;')).toEqual([]);
  });

  it('leaves the baseline alone', () => {
    expect(lintMigration({ version: 1, file: '0001_baseline.sql', sql: 'DROP TABLE x; BEGIN;' })).toEqual([]);
  });
});
