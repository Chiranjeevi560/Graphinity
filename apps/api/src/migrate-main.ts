// Applies the database migrations in db/migrations (see its README).
//
//   MIGRATION_DATABASE_URL=<the schema owner's connection> node apps/api/src/migrate-main.ts
//
// The address is read from the environment, never an argument (arguments are
// visible to every process on the machine), and never printed.
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { connectionSettings, isLocal, targetHost, tlsProblem } from './db-target.ts';
import { MigrationError, migrate, readMigrations } from './migrations.ts';

const url = process.env.MIGRATION_DATABASE_URL;
if (!url) {
  console.error('MIGRATION_DATABASE_URL is not set: the schema owner’s connection, never the API’s.');
  process.exit(1);
}

// Only a person at a terminal, who has read the address, changes a remote database: an earlier
// script reached production by finding this file's connection string (docs/SECURITY.md).
const problem = tlsProblem(url);
if (problem) {
  console.error(`MIGRATION_DATABASE_URL ${problem}.`);
  process.exit(1);
}
if (!isLocal(url)) {
  const host = targetHost(url);
  if (!process.stdin.isTTY) {
    console.error(`Refusing to change ${host} without a person at a terminal.`);
    process.exit(1);
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  console.log(`This changes the database at ${host}. Run "npm run db:backup" first if you haven't today.`);
  const typed = await rl.question('Type that address to go ahead: ');
  rl.close();
  if (typed.trim() !== host) {
    console.error('That doesn’t match, so nothing was changed.');
    process.exit(1);
  }
}

const files = readMigrations(fileURLToPath(new URL('../../../db/migrations', import.meta.url)));
const client = new pg.Client(connectionSettings(url, process.env.DATABASE_CA_PEM));
try {
  await client.connect();
  await migrate(client, files, line => {
    console.log(line);
  });
  const { rows } = await client.query<{ version: number }>('SELECT version FROM app.schema_meta');
  console.log(`schema version ${String(rows[0]?.version ?? 'unknown')}`);
} catch (err) {
  console.error(
    err instanceof MigrationError
      ? err.message
      : `Migration failed: ${err instanceof Error ? err.message : 'unknown error'}`,
  );
  process.exitCode = 1;
} finally {
  await client.end();
}
