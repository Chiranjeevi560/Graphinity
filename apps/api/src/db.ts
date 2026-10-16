import pg from 'pg';

export interface Queryable {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<R>>;
}

export interface Database {
  /** Proves the API's role can reach the database and read our schema. */
  ping(): Promise<{ schemaVersion: number }>;
  /**
   * Runs fn in one transaction as the given person (or anonymously with
   * null). Row-level security policies read this identity, so every query
   * that touches user data must go through here.
   */
  withUser<T>(userId: string | null, fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export interface DatabaseOptions {
  onIdleError?: (err: Error) => void;
}

export function createDatabase(connectionString: string, options: DatabaseOptions = {}): Database {
  const pool = new pg.Pool({
    connectionString,
    // Supabase's free tier allows few connections; the API rarely needs more.
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    // A runaway query must not hold a connection hostage.
    statement_timeout: 5_000,
    idle_in_transaction_session_timeout: 10_000,
    application_name: 'graphinity-api',
  });
  // Without a listener, a dropped idle connection crashes the process.
  pool.on('error', err => options.onIdleError?.(err));

  return {
    async ping() {
      const { rows } = await pool.query<{ version: number }>('SELECT version FROM app.schema_meta');
      const version = rows[0]?.version;
      if (version === undefined) throw new Error('schema_meta is empty; apply db/schema.sql');
      return { schemaVersion: version };
    },

    async withUser(userId, fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // Third argument true = local to this transaction, so the identity
        // can never leak to the next request that reuses this connection.
        await client.query("SELECT set_config('app.user_id', $1, true)", [userId ?? '']);
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },

    close: () => pool.end(),
  };
}
