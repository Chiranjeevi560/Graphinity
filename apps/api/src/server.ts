import Fastify, { LogController, type FastifyError } from 'fastify';
import cors from '@fastify/cors';
import { AuthError, AuthUnavailableError, subjectHash, type SignedInUser, type TokenVerifier } from './auth.ts';
import type { AuthAdmin } from './auth-admin.ts';
import type { Config } from './config.ts';
import type { Database } from './db.ts';
import { TokenBuckets, visitorAddress, visitorKey, type BucketOptions, type Clock } from './rate-limit.ts';
import { registerProfileRoutes } from './routes/profile.ts';
import { createEvents, type Events } from './events.ts';
import { createNetworkMarker } from './networks.ts';
import { registerLiveRoutes } from './routes/live.ts';
import { registerModerationRoutes } from './routes/moderation.ts';
import { registerPointRoutes } from './routes/points.ts';
import { registerGraphRoutes } from './routes/graph.ts';
import { registerPushRoutes } from './routes/push.ts';
import type { Embedder } from './embeddings.ts';
import { createGraphAnalyzer, type GraphAnalyzer } from './graph-analyzer.ts';
import type { Speller } from './ml/spelling.ts';
import { registerQuestionRoutes } from './routes/questions.ts';
import { registerSearchRoutes } from './routes/search.ts';
import { createSearchEngine } from './search/engine.ts';
import type { Rankers } from './search/rankers.ts';
import { registerConsentRoutes } from './routes/consent.ts';
import { registerPersonalGraphRoutes } from './routes/personal-graph.ts';
import { registerRecommendationRoutes } from './routes/recommendations.ts';
import { registerOpsRoutes } from './routes/ops.ts';
import type { MetricsRecorder } from './ops/metrics.ts';

declare module 'fastify' {
  interface FastifyContextConfig {
    /** 'required': refuse without a valid token. 'optional': identify if present. */
    auth?: 'required' | 'optional';
    /** Counts against the person's write allowance. */
    write?: boolean;
    /** Accept a deleted account's still-valid token (only for retrying the deletion). */
    allowRevoked?: boolean;
  }
  interface FastifyRequest {
    user: SignedInUser | null;
  }
}

export interface Limits {
  /** Every visitor together. Protects the single free instance. */
  global: BucketOptions;
  /** Each visitor on their own. */
  visitor: BucketOptions;
  /** Request body size before sign-in is checked. Routes that need more raise it per route. */
  anonymousBodyBytes: number;
  /** Changes one signed-in person can make (profile edits, later posts). */
  userWrites: BucketOptions;
  /** Searches per signed-in person, or per visitor address (POST /search). */
  search: BucketOptions;
  /** Opens and reading times recorded per person (PUT /searches/:id/opens/:position). */
  searchEvents: BucketOptions;
}

export const defaultLimits: Limits = {
  global: { capacity: 400, refillPerSecond: 100, maxKeys: 1 },
  // Generous on purpose: mobile carriers put many people behind one address
  // (common in India), and one page view makes 4-6 calls. The global bucket
  // above still protects the single instance.
  visitor: { capacity: 300, refillPerSecond: 10, maxKeys: 50_000 },
  anonymousBodyBytes: 4 * 1024,
  userWrites: { capacity: 20, refillPerSecond: 1 / 30, maxKeys: 50_000 },
  // A burst of 30, then one every two seconds: well beyond anyone reading the
  // results, well short of scraping. Generous per address for the same
  // carrier reason as the visitor limit.
  search: { capacity: 30, refillPerSecond: 0.5, maxKeys: 50_000 },
  // An open and a reading time per result read: twice the search allowance.
  searchEvents: { capacity: 60, refillPerSecond: 1, maxKeys: 50_000 },
};

/** Everything the server needs from outside, so tests can swap any of it. */
export interface Deps {
  config: Pick<Config, 'production' | 'environment' | 'release' | 'webOrigin' | 'trustProxyHops' | 'ipHashKey'>;
  db: Database;
  clock: Clock;
  auth: TokenVerifier;
  authAdmin: AuthAdmin;
  /** Who should hear about what. Defaults to a fresh in-process hub. */
  events?: Events;
  /** The web push public key, or null/absent when push is off. */
  vapidPublicKey?: string | null;
  /** Embeddings for semantic search; absent: word matching only. */
  embedder?: Embedder | null;
  /** Personal graph analysis off the main thread. Defaults to one worker owned (and closed) by this server. */
  graphAnalyzer?: GraphAnalyzer;
  /** Spelling corrections for the precheck's word search; absent: words as typed only. */
  speller?: Pick<Speller, 'correctDraft'> | null;
  /** Global recommendation kill switch; per-user consent is enforced separately. */
  recommendationsEnabled?: () => boolean;
  /** The search kill switch (POST /search). Defaults to on. */
  searchEnabled?: () => boolean;
  /** Randomness for search's position-bias swaps (ADR 0015 part 6). Defaults to Math.random. */
  searchRandom?: () => number;
  /** The learned search rankings in service (ADR 0015 part 6). Defaults to none: fusion orders results. */
  searchRankers?: () => Rankers;
  limits?: Limits;
  /** Where logs go. Defaults to stdout. */
  logStream?: { write(line: string): void };
  /** Counts every response by route pattern (ADR 0020). */
  metrics?: MetricsRecorder;
}

// Copy for errors: what happened, and what to do.
const messages = {
  invalid: 'Some of what was sent is missing or not in the right format. Check it and try again.',
  tooLarge: 'That was too large to accept. Shorten it and try again.',
  tooMany: 'Too many requests. Wait a minute, then try again.',
  notFound: 'There is nothing at this address.',
  unsupported: 'This kind of request isn’t accepted here.',
  server: 'Something went wrong on our side. Try again in a minute.',
  signedOut: 'You’re signed out. Sign in again to continue.',
  authUnavailable: 'Sign-in can’t be checked right now. Try again in a minute.',
} as const;

const securityHeaders = {
  // The API only ever returns JSON, so it may load nothing and be framed by nothing.
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'strict-transport-security': 'max-age=63072000; includeSubDomains',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-site',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  // Responses may contain personal data; never let a shared cache keep them.
  'cache-control': 'no-store',
};

export async function buildServer(deps: Deps) {
  const { config, db, clock } = deps;
  const limits = deps.limits ?? defaultLimits;

  const app = Fastify({
    // Only the measured number of proxy hops is believed; with 0, the
    // forwarded header is ignored entirely and the socket address is used.
    // Fastify 5.12 deliberately ignores a plain number here (it can't verify
    // the peer), so the hop rule is spelled out as a function. That is safe
    // only because the host's load balancer is the sole way to reach the
    // instance; docs/SECURITY.md records this assumption.
    trustProxy: config.trustProxyHops > 0 ? (_addr: string, hop: number) => hop < config.trustProxyHops : false,
    bodyLimit: limits.anonymousBodyBytes,
    // Slow clients must not tie up the single instance.
    connectionTimeout: 15_000,
    requestTimeout: 15_000,
    routerOptions: { maxParamLength: 200 },
    return503OnClosing: true,
    // A client-supplied request id could be used to inject into logs.
    requestIdHeader: false,
    ajv: {
      // Fastify's defaults quietly fix bad input: drop unknown fields, turn
      // "true" into true. Input that doesn't match the schema is refused instead.
      customOptions: { removeAdditional: false, coerceTypes: false, useDefaults: false },
    },
    // Fastify's own per-request lines include the URL; ours below do not.
    logController: new LogController({ disableRequestLogging: true }),
    logger: {
      level: config.production ? 'info' : 'debug',
      ...(deps.logStream ? { stream: deps.logStream } : {}),
      // No machine name or process id either: a hostname can hold a person's name.
      base: null,
      // Log lines carry no addresses, headers, query strings or bodies.
      serializers: { req: () => ({}), res: () => ({}) },
    },
  });

  const globalBucket = new TokenBuckets(limits.global, clock);
  const visitorBuckets = new TokenBuckets(limits.visitor, clock);

  app.addHook('onRequest', async (req, reply) => {
    reply.headers(securityHeaders);

    // The visitor's own allowance first: a request refused here must not
    // spend the shared allowance, or one address could exhaust it and lock
    // everyone else out.
    const own = visitorBuckets.take(visitorKey(visitorAddress(req.ip), config.ipHashKey));
    const verdict = own.ok ? globalBucket.take('all') : own;
    if (!verdict.ok) {
      reply.header('retry-after', String(verdict.retryAfterSeconds));
      // This runs before the CORS plugin, so add its headers here: without
      // them the browser hides the answer and the website can only say
      // "you seem to be offline".
      if (req.headers.origin === config.webOrigin) {
        reply.headers({
          'access-control-allow-origin': config.webOrigin,
          'access-control-expose-headers': 'retry-after',
          vary: 'Origin',
        });
      }
      return reply.code(429).send({ error: 'rate_limited', message: messages.tooMany });
    }
  });

  await app.register(cors, {
    // A list, not a string: a string is sent back to every caller, while a
    // list is echoed only to a caller that matches it.
    origin: [config.webOrigin],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['authorization', 'content-type'],
    // Sign-in uses a bearer token, never cookies, so credentials stay off.
    credentials: false,
    maxAge: 600,
  });

  // Sign-in check. Runs after the rate limit and before the body is read, so
  // nobody can make the server parse a body without passing both.
  app.decorateRequest('user', null);
  const userWrites = new TokenBuckets(limits.userWrites, clock);
  const markNetwork = createNetworkMarker({
    db,
    key: config.ipHashKey,
    today: () => new Date(clock.now()).toISOString().slice(0, 10),
  });
  app.addHook('onRequest', async (req, reply) => {
    const { auth: mode, write, allowRevoked } = req.routeOptions.config;
    if (!mode) return;
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) {
      if (mode === 'required') return reply.code(401).send({ error: 'signed_out', message: messages.signedOut });
      return;
    }
    try {
      req.user = await deps.auth.verify(token);
    } catch (err) {
      if (err instanceof AuthError) return reply.code(401).send({ error: 'signed_out', message: messages.signedOut });
      if (err instanceof AuthUnavailableError) {
        req.log.warn({ kind: err.name }, 'token keys unavailable');
        return reply.code(503).send({ error: 'auth_unavailable', message: messages.authUnavailable });
      }
      throw err;
    }
    if (!allowRevoked && (await isRevoked(req.user.id))) {
      req.user = null;
      return reply.code(401).send({ error: 'signed_out', message: messages.signedOut });
    }
    if (write) {
      const allowed = userWrites.take(req.user.id);
      if (!allowed.ok) {
        reply.header('retry-after', String(allowed.retryAfterSeconds));
        return reply.code(429).send({ error: 'rate_limited', message: messages.tooMany });
      }
      markNetwork(req.user.id, req.ip);
    }
  });

  // Refused: an account deleted in the last two hours, or one whose sign-in
  // removal at Supabase is still pending (its tokens keep refreshing until then).
  async function isRevoked(userId: string): Promise<boolean> {
    const { rows } = await db.query<{ revoked: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM app.revoked_subjects WHERE subject_hash = $1 AND until > now())
           OR EXISTS (SELECT 1 FROM app.pending_auth_deletions WHERE user_id = $2) AS revoked`,
      [subjectHash(userId, config.ipHashKey), userId],
    );
    return rows[0]?.revoked === true;
  }

  // One line per request: which route pattern (never the raw URL, which may
  // hold a name), the status and the time taken.
  app.addHook('onResponse', async (req, reply) => {
    const route = req.routeOptions.url ?? 'unmatched';
    deps.metrics?.record(route, req.method, reply.statusCode, reply.elapsedTime);
    req.log.info(
      {
        method: req.method,
        route: req.routeOptions.url ?? 'unmatched',
        status: reply.statusCode,
        ms: Math.round(reply.elapsedTime),
      },
      'request',
    );
  });

  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: 'not_found', message: messages.notFound }));

  app.setErrorHandler((err: FastifyError, req, reply) => {
    if (err.validation) return reply.code(400).send({ error: 'invalid_request', message: messages.invalid });
    const status = err.statusCode ?? 500;
    if (status === 413) return reply.code(413).send({ error: 'too_large', message: messages.tooLarge });
    if (status === 415) return reply.code(415).send({ error: 'unsupported', message: messages.unsupported });
    if (status >= 400 && status < 500)
      return reply.code(status).send({ error: 'bad_request', message: messages.invalid });
    // Error messages can quote user input (e.g. a failed constraint's value),
    // so only the error's kind and code are logged, never its message.
    req.log.error({ kind: err.name, code: err.code }, 'unhandled error');
    return reply.code(500).send({ error: 'server_error', message: messages.server });
  });

  app.get('/health', async (req, reply) => {
    try {
      const { schemaVersion } = await withTimeout(db.ping(), 3_000);
      return { status: 'ok', schemaVersion, environment: config.environment, release: config.release };
    } catch (err) {
      req.log.warn({ kind: (err as Error).name }, 'health check failed');
      return reply.code(503).send({ status: 'unavailable' });
    }
  });

  registerProfileRoutes(app, { db, authAdmin: deps.authAdmin, clock, subjectKey: config.ipHashKey, log: app.log });
  registerConsentRoutes(app, { db });
  const analyzer = deps.graphAnalyzer ?? createGraphAnalyzer();
  if (!deps.graphAnalyzer) app.addHook('onClose', () => analyzer.close());
  registerPersonalGraphRoutes(app, { db, analyzer, clock });

  const events = deps.events ?? createEvents();
  const engine = createSearchEngine({ db, embedder: deps.embedder ?? null, speller: deps.speller ?? null });
  registerRecommendationRoutes(app, {
    db,
    enabled: deps.recommendationsEnabled ?? (() => true),
    engine,
    meaningModel: () => deps.embedder?.model ?? null,
  });
  registerQuestionRoutes(app, { db, events, embedder: deps.embedder ?? null, engine });
  registerSearchRoutes(app, {
    db,
    engine,
    enabled: deps.searchEnabled ?? (() => true),
    clock,
    limit: limits.search,
    eventLimit: limits.searchEvents,
    keySecret: config.ipHashKey,
    ...(deps.searchRandom ? { random: deps.searchRandom } : {}),
    ...(deps.searchRankers ? { rankers: deps.searchRankers } : {}),
  });
  registerLiveRoutes(app, { events, clock });
  registerModerationRoutes(app, { db });
  registerPushRoutes(app, { db, vapidPublicKey: deps.vapidPublicKey ?? null });
  registerPointRoutes(app, { db });
  registerGraphRoutes(app, { db, clock });
  registerOpsRoutes(app, { db });

  return app;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error('timeout'));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timer);
  });
}
