import { createTokenVerifier, supabaseKeys } from './auth.ts';
import { createSupabaseAdmin } from './auth-admin.ts';
import { loadConfig, ConfigError } from './config.ts';
import { createDatabase } from './db.ts';
import { completePendingDeletions } from './deletions.ts';
import { createEvents } from './events.ts';
import { errorKind, serial } from './jobs.ts';
import { expireNetworkMarks } from './networks.ts';
import { createLimiter, createPushSender } from './push-sender.ts';
import { routeDueQuestions } from './routing.ts';
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
const events = createEvents();
const app = await buildServer({
  config,
  db,
  clock: systemClock,
  auth: createTokenVerifier({ issuer: `${config.supabaseUrl}/auth/v1`, keys: supabaseKeys(config.supabaseUrl) }),
  authAdmin,
  events,
  vapidPublicKey: config.vapid?.publicKey ?? null,
});
logger.current = app.log;

// Finish any account deletions Supabase couldn't complete at the time: now,
// then every 5 minutes. The keep-awake ping keeps this instance running.
const runDeletions = () => {
  completePendingDeletions({ db, authAdmin, subjectKey: config.ipHashKey, log: app.log })
    .then(r => { if (r.completed || r.failed) app.log.info(r, 'pending deletions'); })
    .catch((err: unknown) => { app.log.warn({ kind: errorKind(err) }, 'pending deletions run failed'); });
  // Network marks are kept 30 days.
  expireNetworkMarks(db).catch((err: unknown) => { app.log.warn({ kind: errorKind(err) }, 'network mark expiry failed'); });
};
runDeletions();
const deletionTimer = setInterval(runDeletions, 5 * 60_000);
deletionTimer.unref();
app.addHook('onClose', (_instance, done) => { clearInterval(deletionTimer); done(); });

// Web push to people's devices, when keys are set (VAPID_*).
if (config.vapid) {
  const push = createPushSender({ db, vapid: config.vapid, fetch: (...args) => fetch(...args), log: app.log, now: () => Date.now() });
  // A wave can publish 100 events at once; at most 2 pushes run together,
  // so requests always find a free database connection (the pool has 5).
  const limit = createLimiter(2);
  events.onPublish((userId, event) => {
    limit(() => push(userId, event)).catch((err: unknown) => { app.log.warn({ kind: errorKind(err) }, 'push run failed'); });
  });
}

// Put questions to people: right after each new question, and every
// minute for the next waves. One run at a time; asks during a run are
// picked up by one more run straight after it.
const runRouting = serial(() => routeDueQuestions(db, app.log)
  .then(results => {
    for (const { questionId, asked } of results) {
      for (const person of asked) events.publish(person, { type: 'routed', questionId });
    }
    const people = results.reduce((n, r) => n + r.asked.length, 0);
    if (people) app.log.info({ questions: results.length, people }, 'routed questions');
  })
  .catch((err: unknown) => { app.log.warn({ kind: errorKind(err) }, 'routing run failed'); }));
events.onAsked(runRouting);
runRouting();
const routingTimer = setInterval(runRouting, 60_000);
routingTimer.unref();
app.addHook('onClose', (_instance, done) => { clearInterval(routingTimer); done(); });

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
        app.log.error({ kind: errorKind(err) }, 'shutdown failed');
        process.exit(1);
      });
  });
}

await app.listen({ host: config.host, port: config.port });
