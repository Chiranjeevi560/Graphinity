// Database migrations (db/migrations/README.md): numbered SQL files applied
// in order, each exactly once, each in its own transaction, recorded with a
// checksum in app.schema_migrations. Forward only: a mistake is fixed by a
// new file, because undoing a change on live data is where data gets lost.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type pg from 'pg';

export interface Migration {
  version: number;
  /** The file name, for messages. */
  file: string;
  sql: string;
  checksum: string;
}

export interface Applied {
  version: number;
  checksum: string;
}

export class MigrationError extends Error {
  override name = 'MigrationError';
}

const FILE_NAME = /^(\d{4})_[a-z0-9_]+\.sql$/;

/**
 * A lock wait longer than this fails the migration instead of queueing every
 * request behind it (an ALTER waiting for a lock blocks reads that arrive
 * after it). Five seconds outlasts any request (15 s server limit aside, the
 * API's queries take milliseconds), so a failure means a real conflict.
 */
export const LOCK_TIMEOUT = '5s';

/** One shared lock, so two deploys starting together can't both migrate. */
const ADVISORY_KEY = 'graphinity:migrations';

export const checksum = (sql: string) => createHash('sha256').update(sql).digest('hex');

/** Every migration in the folder, in order. Refuses gaps, repeats and badly named files. */
export function readMigrations(dir: string): Migration[] {
  const files = readdirSync(dir)
    .filter(f => f.endsWith('.sql'))
    .sort();
  return files.map((file, i) => {
    const match = FILE_NAME.exec(file);
    if (!match) throw new MigrationError(`${file}: name migrations like 0002_add_something.sql`);
    const version = Number(match[1]);
    if (version !== i + 1)
      throw new MigrationError(`${file}: expected ${String(i + 1).padStart(4, '0')} next; numbers run 0001, 0002, …`);
    const sql = readFileSync(join(dir, file), 'utf8');
    return { version, file, sql, checksum: checksum(sql) };
  });
}

/**
 * What still has to run on a database that has `applied`. Pure. Refuses a
 * database that ran a migration this code doesn't have (it is newer: deploy
 * newer code, never roll a database back), and a migration edited after it
 * ran (the change would never reach databases that already have it).
 */
export function plan(files: readonly Migration[], applied: readonly Applied[]): Migration[] {
  applied.forEach((a, i) => {
    if (a.version !== i + 1) throw new MigrationError(`The database's migration record has a gap before ${a.version}.`);
    const f = files[i];
    if (!f)
      throw new MigrationError(
        `The database has migration ${String(a.version)}, which this code doesn't: it is newer. Deploy newer code.`,
      );
    if (f.checksum !== a.checksum)
      throw new MigrationError(`${f.file} changed after it was applied. Put the change in a new migration instead.`);
  });
  return files.slice(applied.length);
}

// The record itself. Forced row-level security with no policy: only a role
// that bypasses it (the schema owner) can read or write it, and the API's
// role has no grant at all.
const LEDGER = `
  SET client_min_messages = warning;
  CREATE SCHEMA IF NOT EXISTS app;
  CREATE TABLE IF NOT EXISTS app.schema_migrations (
    version integer PRIMARY KEY CHECK (version > 0),
    file text NOT NULL CHECK (char_length(file) <= 120),
    checksum text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
    applied_at timestamptz NOT NULL DEFAULT now()
  );
  ALTER TABLE app.schema_migrations ENABLE ROW LEVEL SECURITY;
  ALTER TABLE app.schema_migrations FORCE ROW LEVEL SECURITY;
  REVOKE ALL ON app.schema_migrations FROM PUBLIC;
  RESET client_min_messages;
`;

/**
 * Applies whatever hasn't run yet, in order, and returns what it ran.
 * `client` must connect as the role that owns the schema, and that role must
 * bypass row-level security, as Supabase's `postgres` does (rolsuper false,
 * rolbypassrls true, checked on the project): otherwise it couldn't read its
 * own record, would think nothing had run, and would run everything again.
 */
export async function migrate(
  client: pg.ClientBase,
  files: readonly Migration[],
  log: (line: string) => void = () => undefined,
): Promise<Migration[]> {
  const role = await client.query<{ ok: boolean }>(
    'SELECT rolsuper OR rolbypassrls AS ok FROM pg_roles WHERE rolname = current_user',
  );
  if (!role.rows[0]?.ok)
    throw new MigrationError(
      'The migrating role must bypass row-level security, as the schema owner does on Supabase.',
    );

  await client.query('SELECT pg_advisory_lock(hashtext($1))', [ADVISORY_KEY]);
  try {
    await client.query(LEDGER);
    const { rows } = await client.query<Applied>(
      'SELECT version, checksum FROM app.schema_migrations ORDER BY version',
    );
    const todo = plan(files, rows);
    for (const m of todo) {
      await client.query('BEGIN');
      try {
        await client.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);
        await client.query(m.sql);
        await client.query('INSERT INTO app.schema_migrations (version, file, checksum) VALUES ($1, $2, $3)', [
          m.version,
          m.file,
          m.checksum,
        ]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        // An operator runs this, not a visitor: the database's own words say what broke.
        throw new MigrationError(
          `${m.file} failed and was rolled back: ${err instanceof Error ? err.message : 'unknown error'}`,
        );
      }
      log(`applied ${m.file}`);
    }
    if (todo.length === 0) log('already up to date');
    return todo;
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', [ADVISORY_KEY]);
  }
}

/**
 * Changes that lose data or break the code still running during a deploy
 * (expand/contract: add and switch in one release, remove in a later one).
 * Allowed only in a file that says why, on a line `-- contract: <reason>`.
 */
const DESTRUCTIVE: ReadonlyArray<[RegExp, string]> = [
  [
    /\bDROP\s+(TABLE|SCHEMA|VIEW|MATERIALIZED\s+VIEW|SEQUENCE|TYPE|DOMAIN|EXTENSION)\b/i,
    'drops a table or other object',
  ],
  [/\bDROP\s+COLUMN\b/i, 'drops a column'],
  [/\bTRUNCATE\b/i, 'empties a table'],
  [/\bRENAME\b/i, 'renames something the running code still uses'],
  [/\bALTER\s+COLUMN\s+\S+\s+(SET\s+DATA\s+)?TYPE\b/i, 'changes a column’s type'],
];

const CONTRACT = /^\s*--\s*contract:\s*\S.{9,}$/im;

/** What's wrong with a migration file, in plain words; empty when nothing is. Pure. */
export function lintMigration(m: Pick<Migration, 'version' | 'file' | 'sql'>): string[] {
  // The baseline is history: it was the hand-applied schema, and is never edited again.
  if (m.version === 1) return [];
  const code = m.sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
  const problems: string[] = [];
  if (/(^|;)\s*(BEGIN|START\s+TRANSACTION|COMMIT|ROLLBACK)\s*(;|$)/i.test(code))
    problems.push(`${m.file}: leave out BEGIN and COMMIT; the runner gives every migration its own transaction`);
  if (/\bCONCURRENTLY\b/i.test(code))
    problems.push(`${m.file}: CONCURRENTLY can't run inside the migration's transaction`);
  if (!CONTRACT.test(m.sql))
    for (const [pattern, what] of DESTRUCTIVE)
      if (pattern.test(code))
        problems.push(`${m.file}: ${what}. If that is intended, add a line "-- contract: <why it is safe now>"`);
  return problems;
}
