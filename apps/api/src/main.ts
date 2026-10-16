import { createTokenVerifier, supabaseKeys } from './auth.ts';
import { createSupabaseAdmin } from './auth-admin.ts';
import { loadConfig, ConfigError } from './config.ts';
import { createDatabase } from './db.ts';
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
const app = await buildServer({
  config,
  db,
  clock: systemClock,
  auth: createTokenVerifier({ issuer: `${config.supabaseUrl}/auth/v1`, keys: supabaseKeys(config.supabaseUrl) }),
  authAdmin: createSupabaseAdmin({ supabaseUrl: config.supabaseUrl, secretKey: config.supabaseSecretKey }),
});

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
