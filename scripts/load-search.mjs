#!/usr/bin/env node
// Load test for search (ADR 0015 part 7): the real API server (buildServer)
// over a seeded database (lib/seed-search.mjs), driven over HTTP by many
// concurrent clients, for POST /search and POST /questions/precheck. Reports
// throughput, latency percentiles, errors and the process's memory, at each
// concurrency. Two kinds of searcher: visitors, and signed-in people with
// "improve search for everyone" on, whose searches are also recorded (the
// heaviest path: consent check, history, search and result rows).
//
//   node scripts/load-search.mjs [questions]   (default 100000; needs `npm run db:start`)
//
// The client and the server share one Node process here, so throughput is a
// lower bound; the database pool is the server's own (5 connections). Rate
// limits are raised: this measures the engine, not the limiter.
import { createTokenVerifier } from '../apps/api/src/auth.ts';
import { buildServer, defaultLimits } from '../apps/api/src/server.ts';
import { fakeAuthAdmin, TEST_ISSUER, testIssuer } from '../apps/api/test/helpers/tokens.ts';
import { seedSearchDatabase } from './lib/seed-search.mjs';

const size = Number(process.argv[2] ?? 100_000);
const SECONDS = Number(process.env.SECONDS ?? 10);
const LEVELS = [1, 8, 32];
const PEOPLE = 50;

const { db, embedder, heldOut } = await seedSearchDatabase(size);
const issuer = await testIssuer();
const app = await buildServer({
  config: {
    production: true,
    environment: 'production',
    release: null,
    webOrigin: 'https://graphinity.pages.dev',
    trustProxyHops: 0,
    ipHashKey: Buffer.alloc(32, 9),
  },
  db: db.database,
  clock: { now: () => Date.now() },
  auth: createTokenVerifier({ issuer: TEST_ISSUER, keys: issuer.keys }),
  authAdmin: fakeAuthAdmin(),
  embedder,
  speller: null,
  limits: {
    ...defaultLimits,
    global: { capacity: 1e9, refillPerSecond: 1e9, maxKeys: 1 },
    visitor: { capacity: 1e9, refillPerSecond: 1e9, maxKeys: 10 },
    search: { capacity: 1e9, refillPerSecond: 1e9, maxKeys: 1000 },
    userWrites: { capacity: 1e9, refillPerSecond: 1e9, maxKeys: 1000 },
  },
  logStream: { write: () => {} },
});
await app.listen({ port: 0, host: '127.0.0.1' });
const base = `http://127.0.0.1:${String(app.server.address().port)}`;

// People who allowed recording, set up as they would be.
const tokens = [];
for (let i = 0; i < PEOPLE; i++) {
  const id = crypto.randomUUID();
  const token = await issuer.sign({}, { sub: id });
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  await fetch(`${base}/me/profile`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ handle: `load.${String(i)}`, country: 'IN', fields: ['imports-customs'], adult: true }),
  });
  await fetch(`${base}/me/consents`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      choices: [
        { category: 'search_improvement', enabled: true },
        { category: 'search_history', enabled: true },
      ],
    }),
  });
  tokens.push(token);
}

// Queries as people type them: the first few words of a held-out question's details.
const queries = heldOut.slice(0, 2000).map(q => q.body.split(' ').slice(0, 6).join(' '));
const titles = heldOut.slice(0, 2000).map(q => q.title);

const pct = (xs, q) => {
  const s = [...xs].sort((a, b) => a - b);
  return +(s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? 0).toFixed(1);
};

async function run(label, concurrency, request) {
  const latencies = [];
  let errors = 0;
  let n = 0;
  const until = performance.now() + SECONDS * 1000;
  const rssBefore = process.memoryUsage().rss;
  await Promise.all(
    Array.from({ length: concurrency }, async (_, worker) => {
      while (performance.now() < until) {
        const i = n++;
        const t = performance.now();
        const res = await request(i, worker).catch(() => null);
        latencies.push(performance.now() - t);
        if (!res || res.status !== 200) errors++;
        else await res.arrayBuffer();
      }
    }),
  );
  return {
    label,
    concurrency,
    requests: latencies.length,
    rps: Math.round(latencies.length / SECONDS),
    p50: pct(latencies, 0.5),
    p95: pct(latencies, 0.95),
    p99: pct(latencies, 0.99),
    errors,
    rssMB: Math.round(process.memoryUsage().rss / 1e6),
    rssGrowthMB: Math.round((process.memoryUsage().rss - rssBefore) / 1e6),
  };
}

const post = (path, body, token) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });

const results = [];
try {
  // Warm the caches as a running server's would be.
  await run('warm-up', 8, i => post('/search', { query: queries[i % queries.length] }));
  for (const c of LEVELS) {
    results.push(await run('search (visitor)', c, i => post('/search', { query: queries[i % queries.length] })));
    results.push(
      await run('search (recorded)', c, (i, w) =>
        post('/search', { query: queries[(i * 7) % queries.length] }, tokens[w % tokens.length]),
      ),
    );
    results.push(
      await run('precheck (visitor)', c, i => post('/questions/precheck', { title: titles[i % titles.length] })),
    );
  }
  const recorded = await db.owner.query('SELECT count(*)::int AS n FROM app.searches');
  console.log(
    JSON.stringify({ questions: size, seconds: SECONDS, recordedSearches: recorded.rows[0].n, results }, null, 1),
  );
} finally {
  await app.close();
  await db.close();
}
