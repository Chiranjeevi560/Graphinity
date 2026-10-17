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

const db = createDatabase(config.databaseUrl, {
  onIdleError: err => app.log.warn({ kind: err.name }, 'database connection dropped'),
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

const app = await buildServer({
  config,
  db,
  clock: systemClock,
  auth: createTokenVerifier({ issuer: `${config.supabaseUrl}/auth/v1`, keys: supabaseKeys(config.supabaseUrl) }),
  authAdmin: createSupabaseAdmin({ supabaseUrl: config.supabaseUrl, secretKey: config.supabaseSecretKey }),
});


// Finish any account deletions Supabase couldn't complete at the time: now,
// then every 5 minutes. The keep-awake ping keeps this instance running.
const authAdmin = createSupabaseAdmin({ supabaseUrl: config.supabaseUrl, secretKey: config.supabaseSecretKey });
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
// in-flight requests, then release database connections.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, async () => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    await db.close();
    process.exit(0);
  });
}

await app.listen({ host: config.host, port: config.port });
