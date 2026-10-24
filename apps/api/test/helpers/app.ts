// The real server against a throwaway database, with a test key standing in
// for Supabase's signing key and a clock the test controls. Shared by the
// integration tests that go through HTTP.
import { randomUUID } from 'node:crypto';
import { createTokenVerifier } from '../../src/auth.ts';
import type { Embedder } from '../../src/embeddings.ts';
import { createEvents } from '../../src/events.ts';
import { buildServer, defaultLimits } from '../../src/server.ts';
import { createTestDatabase } from './database.ts';
import { fakeAuthAdmin, TEST_ISSUER, testIssuer } from './tokens.ts';

export const IP_HASH_KEY = Buffer.alloc(32, 9);

export async function startApp(
  now: () => number,
  opts: { vapidPublicKey?: string; embedder?: Embedder; recommendationsEnabled?: () => boolean } = {},
) {
  const t = await createTestDatabase();
  const issuer = await testIssuer();
  const admin = fakeAuthAdmin();
  const events = createEvents();
  const app = await buildServer({
    config: {
      production: true,
      environment: 'production',
      release: null,
      webOrigin: 'https://graphinity.pages.dev',
      trustProxyHops: 0,
      ipHashKey: IP_HASH_KEY,
    },
    db: t.database,
    clock: { now },
    auth: createTokenVerifier({ issuer: TEST_ISSUER, keys: issuer.keys }),
    authAdmin: admin,
    events,
    vapidPublicKey: opts.vapidPublicKey ?? null,
    embedder: opts.embedder ?? null,
    ...(opts.recommendationsEnabled ? { recommendationsEnabled: opts.recommendationsEnabled } : {}),
    // Generous limits: these tests are about behaviour, not rate limiting.
    limits: {
      ...defaultLimits,
      visitor: { capacity: 10_000, refillPerSecond: 1000, maxKeys: 10 },
      userWrites: { capacity: 1000, refillPerSecond: 100, maxKeys: 100 },
    },
    logStream: { write: () => {} },
  });

  /** A new person: their id and a valid token. */
  async function person() {
    const id = randomUUID();
    return { id, token: await issuer.sign({}, { sub: id }) };
  }

  function call(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, token?: string, payload?: object) {
    return app.inject({
      method,
      url,
      headers: token ? { authorization: `Bearer ${token}` } : {},
      ...(payload ? { payload } : {}),
    });
  }

  return {
    t,
    issuer,
    admin,
    events,
    app,
    person,
    call,
    close: async () => {
      await app.close();
      await t.close();
    },
  };
}

export type TestApp = Awaited<ReturnType<typeof startApp>>;
