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
  /**
   * One statement with no signed-in identity and no transaction: for reads
   * that every visitor may make (row-level security still applies, as
   * anonymous). One round trip instead of four.
   */
  query: Queryable['query'];
  /**
   * Throws unless we are connected as the restricted role. An owner or
   * superuser login silently skips every row-level security policy, so the
   * server must refuse to start with one.
   */
  assertRestricted(): Promise<void>;
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
      // The pool only listens for errors on idle connections. A connection
      // that drops while a request holds it emits 'error' with no listener,
      // which crashes the whole process. Catch it here; the failing query
      // already reports the problem to the request.
      let broken: Error | undefined;
      const onError = (err: Error) => { broken = err; };
      client.on('error', onError);
      try {
        await client.query('BEGIN');
        // Third argument true = local to this transaction, so the identity
        // can never leak to the next request that reuses this connection.
        await client.query("SELECT set_config('app.user_id', $1, true)", [userId ?? '']);
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch((rollbackErr: unknown) => {
          broken ??= rollbackErr instanceof Error ? rollbackErr : new Error('rollback failed');
        });
        throw err;
      } finally {
        client.off('error', onError);
        // Passing the error destroys the connection instead of reusing it.
        client.release(broken);
      }
    },

    query: (text, values) => pool.query(text, values),

    async assertRestricted() {
      const { rows } = await pool.query<{ rolsuper: boolean; rolbypassrls: boolean; owned: number }>(
        `SELECT r.rolsuper, r.rolbypassrls,
                (SELECT count(*)::int FROM pg_tables t WHERE t.schemaname = 'app' AND t.tableowner = current_user) AS owned
         FROM pg_roles r WHERE r.rolname = current_user`);
      const role = rows[0];
      if (!role) throw new Error('could not read the database role');
      if (role.rolsuper) throw new Error('DATABASE_URL logs in as a superuser; use the restricted API role');
      if (role.rolbypassrls) throw new Error('DATABASE_URL logs in as a role that can bypass row-level security; use the restricted API role');
      if (role.owned > 0) throw new Error('DATABASE_URL logs in as the role that owns the tables; use the restricted API role');
    },

    close: () => pool.end(),
  };
}
