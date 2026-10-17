import { createTokenVerifier, supabaseKeys } from './auth.ts';
import { createSupabaseAdmin } from './auth-admin.ts';
import { loadConfig, ConfigError } from './config.ts';
import { createDatabase } from './db.ts';
import { completePendingDeletions } from './deletions.ts';
import { systemClock } from './rate-limit.ts';
import { buildServer } from './server.ts';

let config;
try {
  config = loadConfig();
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}

// Declared before the database so its error listener never touches an
// uninitialised variable; until the server exists, warnings go to stderr.
const logger: { current?: Awaited<ReturnType<typeof buildServer>>['log'] } = {};
const db = createDatabase(config.databaseUrl, {
  onIdleError: err => {
    if (logger.current) logger.current.warn({ kind: err.name }, 'database connection dropped');
    else console.warn('database connection dropped');
  },
});
// Refuse to start as an all-powerful database login: row-level security
// would be silently skipped.
try {
  await db.assertRestricted();
} catch (err) {
  console.error(`Refusing to start: ${err instanceof Error ? err.message : 'database check failed'}`);
  await db.close();
  process.exit(1);
}

const authAdmin = createSupabaseAdmin({ supabaseUrl: config.supabaseUrl, secretKey: config.supabaseSecretKey });
const app = await buildServer({
  config,
  db,
  clock: systemClock,
  auth: createTokenVerifier({ issuer: `${config.supabaseUrl}/auth/v1`, keys: supabaseKeys(config.supabaseUrl) }),
  authAdmin,
});
logger.current = app.log;

// Finish any account deletions Supabase couldn't complete at the time: now,
// then every 5 minutes. The keep-awake ping keeps this instance running.
const runDeletions = () => {
  completePendingDeletions({ db, authAdmin, subjectKey: config.ipHashKey, log: app.log })
    .then(r => { if (r.completed || r.failed) app.log.info(r, 'pending deletions'); })
    .catch((err: unknown) => { app.log.warn({ kind: err instanceof Error ? err.name : 'unknown' }, 'pending deletions run failed'); });
};
runDeletions();
const deletionTimer = setInterval(runDeletions, 5 * 60_000);
deletionTimer.unref();
app.addHook('onClose', (_instance, done) => { clearInterval(deletionTimer); done(); });

// Render sends SIGTERM before replacing or stopping the instance. Finish
// in-flight requests, then release database connections. A failure while
// closing is logged and still ends the process, and a stuck close can't
// keep it alive forever.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, 'shutting down');
    setTimeout(() => process.exit(1), 25_000).unref();
    app.close()
      .then(() => db.close())
      .then(() => process.exit(0), (err: unknown) => {
        app.log.error({ kind: err instanceof Error ? err.name : 'unknown' }, 'shutdown failed');
        process.exit(1);
      });
  });
}

await app.listen({ host: config.host, port: config.port });
