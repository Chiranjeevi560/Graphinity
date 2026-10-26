import { createTokenVerifier, supabaseKeys } from './auth.ts';
import { createSupabaseAdmin } from './auth-admin.ts';
import { loadConfig, ConfigError } from './config.ts';
import { createDatabase } from './db.ts';
import { detectCollusion } from './collusion.ts';
import { completePendingDeletions } from './deletions.ts';
import { createRecorder } from './ops/metrics.ts';
import { compactMinutes, recordedRun, saveMinute } from './ops/store.ts';
import { monitorDrift } from './ml/drift-monitor.ts';
import { createEvents } from './events.ts';
import { embedMissing } from './backfill.ts';
import { chooseEmbedder } from './embeddings.ts';
import { errorKind, serial } from './jobs.ts';
import { createFlags, switchedEmbedder } from './flags.ts';
import { ownEmbedderFromArtifact, swappableEmbedder } from './ml/own-embedder.ts';
import { loadServing } from './ml/registry.ts';
import { deserializeSpelling, speller, swappableSpeller } from './ml/spelling.ts';
import {
  ROUTING,
  SPELLING,
  TEXT_EMBEDDING,
  trainRoutingJob,
  trainSearchRankerJob,
  trainSpellingJob,
  trainTextEmbeddingJob,
} from './ml/training.ts';
import { purgeOldRouteFactors } from './ml/routing-data.ts';
import { purgeExpiredSearches } from './search/log.ts';
import { loadComparable } from './ml/registry.ts';
import { deserializeLambdaMart } from './ml/lambdamart.ts';
import { ROLLBACK_DAYS, runSearchJudge } from './search/judge.ts';
import { NO_RANKERS, SEARCH_RANKER, type Rankers } from './search/rankers.ts';
import { monitorRouting } from './ml/routing-monitor.ts';
import { deserializeRoutingModel, scoreRouting, scoreRoutingAt, type RoutingModel } from './ml/routing-model.ts';
import { personalGraphQueueStatus, projectPersonalGraphSignals, purgeExpiredPersonalSignals } from './personal-data.ts';
import { expireNetworkMarks } from './networks.ts';
import { createLimiter, createPushSender } from './push-sender.ts';
import { announceRouting, routeDueQuestions, type Explorer, type Ranker } from './routing.ts';
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

// Kill switches (app.feature_flags), read now and every 30 seconds.
const flags = createFlags(db, {
  onChange: (name, enabled) => logger.current?.info({ flag: name, enabled }, 'feature flag changed'),
});
await flags.refresh();

// Search by meaning: Graphinity's own model (ADR 0010) once one has been
// trained and promoted; until then whatever chooseEmbedder picks (a local
// stand-in in development, matching by words in production). Off while the
// `embeddings` switch is off.
const live = swappableEmbedder(chooseEmbedder(config));
try {
  const serving = await loadServing(db, TEXT_EMBEDDING);
  if (serving) live.set(ownEmbedderFromArtifact(serving.artifact, serving.version));
} catch (err) {
  console.warn(`serving text model not loaded (${errorKind(err)}); search works by words until it is`);
}
const embedder = switchedEmbedder(live.embedder, flags);

// Spelling correction (ADR 0011), Graphinity's own once a version has been
// promoted; until then the precheck searches words as typed.
const spelling = swappableSpeller();
try {
  const serving = await loadServing(db, SPELLING);
  if (serving) spelling.set(speller(deserializeSpelling(serving.artifact)));
} catch (err) {
  console.warn(`serving spelling model not loaded (${errorKind(err)}); words are searched as typed until it is`);
}

// Learned routing (ADR 0013): a promoted model ranks exploit places only
// while the owner has `learned_routing` switched on; otherwise Ψ ranks all.
let routingModel: { version: number; model: RoutingModel } | null = null;
const loadRoutingModel = async () => {
  const serving = await loadServing(db, ROUTING);
  routingModel = serving ? { version: serving.version, model: deserializeRoutingModel(serving.artifact) } : null;
};
try {
  await loadRoutingModel();
} catch (err) {
  console.warn(`serving routing model not loaded (${errorKind(err)}); Ψ ranks everyone until it is`);
}
const explorer = (): Explorer | null => {
  const serving = routingModel;
  return serving && flags.enabled('routing_exploration') ? { version: serving.version, model: serving.model } : null;
};
const ranker = (): Ranker | null => {
  const serving = routingModel;
  if (!serving || !flags.enabled('learned_routing')) return null;
  return {
    version: serving.version,
    score: factors => scoreRouting(serving.model, factors),
    predicted: (factors, wave) => scoreRoutingAt(serving.model, factors, wave),
  };
};

// Learned search ranking (ADR 0015 part 6): the serving model and any challenger
// (a waiting candidate, or the version a promotion replaced), reloaded after
// each training run and judgement. Serves only with `learned_search_ranking` on.
let searchRankers: Rankers = NO_RANKERS;
const loadSearchRankers = async () => {
  const v = await loadComparable(db, SEARCH_RANKER, ROLLBACK_DAYS);
  const served = (x: typeof v.production) =>
    x ? { id: `lambdamart:v${String(x.version)}`, model: deserializeLambdaMart(x.artifact) } : null;
  const challenger = v.candidate ?? v.retired;
  searchRankers = { production: served(v.production) ?? NO_RANKERS.production, challenger: served(challenger) };
};
try {
  await loadSearchRankers();
} catch (err) {
  console.warn(`search rankers not loaded (${errorKind(err)}); fusion orders results until they are`);
}

const authAdmin = createSupabaseAdmin({ supabaseUrl: config.supabaseUrl, secretKey: config.supabaseSecretKey });
const events = createEvents();
const metrics = createRecorder();
const app = await buildServer({
  metrics,
  config,
  db,
  clock: systemClock,
  auth: createTokenVerifier({ issuer: `${config.supabaseUrl}/auth/v1`, keys: supabaseKeys(config.supabaseUrl) }),
  authAdmin,
  events,
  vapidPublicKey: config.vapid?.publicKey ?? null,
  embedder,
  speller: spelling.speller,
  recommendationsEnabled: () => flags.enabled('recommendations'),
  searchEnabled: () => flags.enabled('search'),
  searchRankers: () => (flags.enabled('learned_search_ranking') ? searchRankers : NO_RANKERS),
});
logger.current = app.log;

// Request metrics (ADR 0020): this minute's counts into Postgres once a
// minute, so the operations page and SLO alerts survive the free instance
// sleeping. A failed save drops one minute of counts, never a request.
const flushMetrics = () => {
  const rows = metrics.flush();
  db.asSystem(async q => {
    await saveMinute(q, new Date(), rows);
    await compactMinutes(q);
  }).catch((err: unknown) => {
    app.log.warn({ kind: errorKind(err) }, 'metrics flush failed');
  });
};
const metricsTimer = setInterval(flushMetrics, 60_000);
metricsTimer.unref();
app.addHook('onClose', (_instance, done) => {
  clearInterval(metricsTimer);
  flushMetrics();
  done();
});

// Finish any account deletions Supabase couldn't complete at the time: now,
// then every 5 minutes. The keep-awake ping keeps this instance running.
const runDeletions = () => {
  recordedRun(db, 'deletions', 300, () =>
    completePendingDeletions({ db, authAdmin, subjectKey: config.ipHashKey, log: app.log }),
  )
    .then(r => {
      if (r.completed || r.failed) app.log.info(r, 'pending deletions');
    })
    .catch((err: unknown) => {
      app.log.warn({ kind: errorKind(err) }, 'pending deletions run failed');
    });
  // Network marks are kept 30 days.
  expireNetworkMarks(db).catch((err: unknown) => {
    app.log.warn({ kind: errorKind(err) }, 'network mark expiry failed');
  });
};
runDeletions();
const deletionTimer = setInterval(runDeletions, 5 * 60_000);
deletionTimer.unref();
app.addHook('onClose', (_instance, done) => {
  clearInterval(deletionTimer);
  done();
});

// Personal signal events have a documented maximum 365-day retention.
const purgeSignals = () => {
  recordedRun(db, 'signal-expiry', 3600, () => purgeExpiredPersonalSignals(db)).then(
    deleted => {
      if (deleted) app.log.info({ deleted }, 'expired personal signals removed');
    },
    (err: unknown) => {
      app.log.warn({ kind: errorKind(err) }, 'personal signal expiry failed');
    },
  );
  // Routing factors are kept 180 days (migration 0016), then deleted.
  recordedRun(db, 'route-factor-expiry', 3600, () => purgeOldRouteFactors(db)).then(
    deleted => {
      if (deleted) app.log.info({ deleted }, 'old routing factors removed');
    },
    (err: unknown) => {
      app.log.warn({ kind: errorKind(err) }, 'routing factor expiry failed');
    },
  );
  // Searches recorded to improve search are kept 365 days at most (migration 0022).
  recordedRun(db, 'search-expiry', 3600, () => purgeExpiredSearches(db)).then(
    deleted => {
      if (deleted) app.log.info({ deleted }, 'expired searches removed');
    },
    (err: unknown) => {
      app.log.warn({ kind: errorKind(err) }, 'search expiry failed');
    },
  );
};
purgeSignals();
const personalSignalTimer = setInterval(purgeSignals, 60 * 60_000);
personalSignalTimer.unref();
app.addHook('onClose', (_instance, done) => {
  clearInterval(personalSignalTimer);
  done();
});

// Graph projection is bounded and asynchronous so user-facing writes only add
// the consented source event; a worker claims at most 100 events per pass.
const projectGraphSignals = () => {
  recordedRun(db, 'graph-projection', 15, () => projectPersonalGraphSignals(db)).then(
    projected => {
      if (projected) app.log.info({ projected }, 'personal graph events projected');
    },
    (err: unknown) => {
      app.log.warn({ kind: errorKind(err) }, 'personal graph projection failed');
    },
  );
};
projectGraphSignals();
const graphProjectionTimer = setInterval(projectGraphSignals, 15_000);
graphProjectionTimer.unref();
app.addHook('onClose', (_instance, done) => {
  clearInterval(graphProjectionTimer);
  done();
});

const monitorGraphProjection = () => {
  personalGraphQueueStatus(db).then(
    status => {
      if (status.pending === 0) return;
      const fields = { pending: status.pending, oldestSeconds: Math.round(status.oldestSeconds) };
      if (status.oldestSeconds >= 300) {
        app.log.warn(fields, 'personal graph projection queue lag exceeded five minutes');
      } else {
        app.log.info(fields, 'personal graph projection queue has pending events');
      }
    },
    (err: unknown) => {
      app.log.warn({ kind: errorKind(err) }, 'personal graph queue monitoring failed');
    },
  );
};
monitorGraphProjection();
const graphProjectionMonitorTimer = setInterval(monitorGraphProjection, 60_000);
graphProjectionMonitorTimer.unref();
app.addHook('onClose', (_instance, done) => {
  clearInterval(graphProjectionMonitorTimer);
  done();
});

// Web push to people's devices, when keys are set (VAPID_*).
if (config.vapid) {
  const push = createPushSender({
    db,
    vapid: config.vapid,
    fetch: (...args) => fetch(...args),
    log: app.log,
    now: () => Date.now(),
  });
  // A wave can publish 100 events at once; at most 2 pushes run together,
  // so requests always find a free database connection (the pool has 5).
  const limit = createLimiter(2);
  events.onPublish((userId, event) => {
    if (!flags.enabled('push')) return;
    limit(() => push(userId, event)).catch((err: unknown) => {
      app.log.warn({ kind: errorKind(err) }, 'push run failed');
    });
  });
}

// Put questions to people: right after each new question, and every
// minute for the next waves. One run at a time; asks during a run are
// picked up by one more run straight after it.
const runRouting = serial(() =>
  recordedRun(db, 'routing', 60, () => routeDueQuestions(db, app.log, ranker, explorer))
    .then(results => {
      announceRouting(events, results);
      const people = results.reduce((n, r) => n + r.asked.length, 0);
      if (people) app.log.info({ questions: results.length, people }, 'routed questions');
    })
    .catch((err: unknown) => {
      app.log.warn({ kind: errorKind(err) }, 'routing run failed');
    }),
);
events.onAsked(runRouting);
// Embeddings a question is missing, a few each minute.
const runBackfill = serial(async () => {
  if (!flags.enabled('embeddings') || !live.current()) return;
  await recordedRun(db, 'embedding-backfill', 60, () => embedMissing(db, embedder)).then(
    n => {
      if (n) app.log.info({ questions: n }, 'embedded questions');
    },
    (err: unknown) => {
      app.log.warn({ kind: errorKind(err) }, 'embedding backfill failed');
    },
  );
});
runRouting();
const routingTimer = setInterval(() => {
  runRouting();
  runBackfill();
}, 60_000);
routingTimer.unref();

// Train Graphinity's own models daily, on a worker thread (ADR 0010, 0011):
// first 10 minutes after start, so a restart isn't slowed. A version that
// wins its quality gate serves at once. Logs carry numbers only, never text.
const runTraining = serial(async () => {
  if (!flags.enabled('model_training')) return;
  // Recorded as one run: each model's step below logs its own failures and carries on.
  await recordedRun(db, 'training', 86_400, trainAll).catch((err: unknown) => {
    app.log.warn({ kind: errorKind(err) }, 'training run failed');
  });
});
async function trainAll() {
  try {
    const outcome = await trainTextEmbeddingJob(db);
    if (outcome.status === 'promoted') {
      const serving = await loadServing(db, TEXT_EMBEDDING);
      if (serving) live.set(ownEmbedderFromArtifact(serving.artifact, serving.version));
    }
    app.log.info(
      outcome.status === 'skipped'
        ? { model: TEXT_EMBEDDING, status: outcome.status }
        : {
            model: TEXT_EMBEDDING,
            status: outcome.status,
            version: outcome.version,
            mrr: outcome.result.metrics.mrr,
            baselineMrr: outcome.result.baseline.mrr,
            queries: outcome.result.metrics.queries,
            trainMs: outcome.result.metrics.trainMs,
          },
      'model training',
    );
  } catch (err) {
    app.log.warn({ kind: errorKind(err), model: TEXT_EMBEDDING }, 'model training failed');
  }
  try {
    const outcome = await trainSpellingJob(db);
    if (outcome.status === 'promoted') {
      const serving = await loadServing(db, SPELLING);
      if (serving) spelling.set(speller(deserializeSpelling(serving.artifact)));
    }
    app.log.info(
      outcome.status === 'skipped'
        ? { model: SPELLING, status: outcome.status }
        : {
            model: SPELLING,
            status: outcome.status,
            version: outcome.version,
            precision: outcome.result.metrics.precision,
            recall: outcome.result.metrics.recall,
            typos: outcome.result.metrics.typos,
            trainMs: outcome.result.metrics.trainMs,
          },
      'model training',
    );
  } catch (err) {
    app.log.warn({ kind: errorKind(err), model: SPELLING }, 'model training failed');
  }
  try {
    const outcome = await trainRoutingJob(db);
    if (outcome.status === 'promoted') await loadRoutingModel();
    app.log.info(
      outcome.status === 'skipped'
        ? { model: ROUTING, status: outcome.status }
        : {
            model: ROUTING,
            status: outcome.status,
            version: outcome.version,
            auc: outcome.result.metrics.candidateAuc,
            psiAuc: outcome.result.metrics.psiAuc,
            askers: outcome.result.metrics.askers,
            trainMs: outcome.result.metrics.trainMs,
          },
      'model training',
    );
  } catch (err) {
    app.log.warn({ kind: errorKind(err), model: ROUTING }, 'model training failed');
  }
  try {
    const outcome = await trainSearchRankerJob(db);
    if (outcome.status === 'candidate') await loadSearchRankers();
    app.log.info(
      outcome.status === 'skipped'
        ? { model: SEARCH_RANKER, status: outcome.status }
        : {
            model: SEARCH_RANKER,
            status: outcome.status,
            version: outcome.version,
            ipsNdcg: outcome.result.metrics.candidate,
            baseline: outcome.result.baseline.score,
            heldOutPeople: outcome.result.dataset.heldOutPeople,
            trainMs: outcome.result.metrics.trainMs,
          },
      'model training',
    );
  } catch (err) {
    app.log.warn({ kind: errorKind(err), model: SEARCH_RANKER }, 'model training failed');
  }
  // The serving routing model, checked against what happened (ADR 0014): retired if it falls
  // short, and exploration's numbers. Logs carry counts and rates only.
  try {
    const watch = await monitorRouting(db);
    if (watch.calibration?.demote) {
      // Out of service now, even if reloading fails: a retired model must never keep ranking.
      routingModel = null;
      await loadRoutingModel();
      app.log.warn({ model: ROUTING, version: watch.version, z: watch.calibration.z }, 'routing model retired');
    }
    app.log.info(
      {
        model: ROUTING,
        version: watch.version,
        calibrationRoutes: watch.calibration?.routes ?? 0,
        z: watch.calibration?.z ?? null,
        decided: watch.exploration.decided,
        explored: watch.exploration.explored,
        exploredHelped: watch.exploration.exploredHelped,
        keptHelped: watch.exploration.keptHelped,
        neverExploreValue: watch.exploration.neverExploreValue,
        actualValue: watch.exploration.actualValue,
      },
      'routing monitor',
    );
  } catch (err) {
    app.log.warn({ kind: errorKind(err), model: ROUTING }, 'routing monitor failed');
  }
}
// Online comparison of search rankings (ADR 0015 part 6), hourly: promote a
// candidate that wins, reject one that loses, roll back a promotion that the
// replaced version beats. Counts and the interval only in logs.
const judgeSearch = () => {
  if (!flags.enabled('learned_search_ranking')) return;
  recordedRun(db, 'search-judge', 3600, () => runSearchJudge(db)).then(
    async outcome => {
      if (outcome.action !== 'none') await loadSearchRankers();
      app.log.info(
        {
          model: SEARCH_RANKER,
          action: outcome.action,
          decided: outcome.verdict?.decided ?? 0,
          people: outcome.verdict?.people ?? 0,
          mean: outcome.verdict?.mean ?? null,
          low: outcome.verdict?.low ?? null,
          high: outcome.verdict?.high ?? null,
        },
        'search judge',
      );
    },
    (err: unknown) => {
      app.log.warn({ kind: errorKind(err), model: SEARCH_RANKER }, 'search judge failed');
    },
  );
};
const searchJudgeTimer = setInterval(judgeSearch, 60 * 60_000);
searchJudgeTimer.unref();
app.addHook('onClose', (_instance, done) => {
  clearInterval(searchJudgeTimer);
  done();
});
const firstTraining = setTimeout(runTraining, 10 * 60_000);
firstTraining.unref();
const trainingTimer = setInterval(runTraining, 24 * 60 * 60_000);
trainingTimer.unref();
app.addHook('onClose', (_instance, done) => {
  clearTimeout(firstTraining);
  clearInterval(trainingTimer);
  done();
});
// Drift monitoring (ADR 0018), daily: how far each serving model's inputs
// moved from its training data. Drift starts training at once rather than
// at the next daily run; the gates still decide whether a new version serves.
// Numbers about features only in logs.
const runDriftMonitor = serial(async () => {
  try {
    const report = await recordedRun(db, 'drift-monitor', 86_400, () => monitorDrift(db));
    for (const m of report)
      app.log.info(
        {
          model: m.model,
          version: m.version ?? null,
          skipped: m.skipped ?? null,
          errorKind: m.errorKind ?? null,
          drifted: m.features.filter(f => f.drifted).map(f => f.feature),
          maxPsi: Math.max(0, ...m.features.map(f => f.psi)),
        },
        'drift monitor',
      );
    if (report.some(m => m.drifted)) runTraining();
  } catch (err) {
    app.log.warn({ kind: errorKind(err) }, 'drift monitor failed');
  }
});
const firstDriftMonitor = setTimeout(runDriftMonitor, 30 * 60_000);
firstDriftMonitor.unref();
const driftMonitorTimer = setInterval(runDriftMonitor, 24 * 60 * 60_000);
driftMonitorTimer.unref();
app.addHook('onClose', (_instance, done) => {
  clearTimeout(firstDriftMonitor);
  clearInterval(driftMonitorTimer);
  done();
});
// Collusion review (ADR 0017), daily: groups giving each other points go to
// moderators; nothing happens to anyone until one decides. Counts only in logs.
const runCollusion = serial(async () => {
  try {
    const outcome = await recordedRun(db, 'collusion-review', 86_400, () => detectCollusion(db));
    app.log.info(outcome, 'collusion review');
  } catch (err) {
    app.log.warn({ kind: errorKind(err) }, 'collusion review failed');
  }
});
const firstCollusion = setTimeout(runCollusion, 20 * 60_000);
firstCollusion.unref();
const collusionTimer = setInterval(runCollusion, 24 * 60 * 60_000);
collusionTimer.unref();
app.addHook('onClose', (_instance, done) => {
  clearTimeout(firstCollusion);
  clearInterval(collusionTimer);
  done();
});
app.addHook('onClose', (_instance, done) => {
  clearInterval(routingTimer);
  flags.stop();
  done();
});

// Render sends SIGTERM before replacing or stopping the instance. Finish
// in-flight requests, then release database connections. A failure while
// closing is logged and still ends the process, and a stuck close can't
// keep it alive forever.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, 'shutting down');
    setTimeout(() => process.exit(1), 25_000).unref();
    app
      .close()
      .then(() => db.close())
      .then(
        () => process.exit(0),
        (err: unknown) => {
          app.log.error({ kind: errorKind(err) }, 'shutdown failed');
          process.exit(1);
        },
      );
  });
}

await app.listen({ host: config.host, port: config.port });
