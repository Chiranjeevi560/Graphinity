// Applies the database migrations in db/migrations (see its README).
//
//   MIGRATION_DATABASE_URL=<the schema owner's connection> node apps/api/src/migrate-main.ts
//
// The address is read from the environment, never an argument (arguments are
// visible to every process on the machine), and never printed.
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { MigrationError, migrate, readMigrations } from './migrations.ts';

const url = process.env.MIGRATION_DATABASE_URL;
if (!url) {
  console.error('MIGRATION_DATABASE_URL is not set: the schema owner’s connection, never the API’s.');
  process.exit(1);
}

const files = readMigrations(fileURLToPath(new URL('../../../db/migrations', import.meta.url)));
const client = new pg.Client({ connectionString: url });
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
