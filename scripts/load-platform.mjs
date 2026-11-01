#!/usr/bin/env node
// Load test for the routes added with the platform work: reading a question while signed in (which now also writes
// memory and ad interest for people who allow them), the topics-next address and the sitemap, both open to anyone.
// Same setup and caveats as load-search.mjs: the real server over HTTP, client in one process, limits raised.
//
//   node scripts/load-platform.mjs [questions]   (default 20000; needs `npm run db:start`)
import { createTokenVerifier } from '../apps/api/src/auth.ts';
import { buildServer, defaultLimits } from '../apps/api/src/server.ts';
import { fakeAuthAdmin, TEST_ISSUER, testIssuer } from '../apps/api/test/helpers/tokens.ts';
import { seedSearchDatabase } from './lib/seed-search.mjs';

const size = Number(process.argv[2] ?? 20_000);
const SECONDS = Number(process.env.SECONDS ?? 8);
const LEVELS = [1, 8, 32];
const PEOPLE = 20;

const { db, embedder } = await seedSearchDatabase(size);
const issuer = await testIssuer();
const open = { capacity: 1e9, refillPerSecond: 1e9, maxKeys: 1000 };
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
  limits: { ...defaultLimits, global: open, visitor: open, search: open, userWrites: open, ads: open },
  logStream: { write: () => {} },
});
await app.listen({ port: 0, host: '127.0.0.1' });
const base = `http://127.0.0.1:${String(app.server.address().port)}`;

const tokens = [];
for (let i = 0; i < PEOPLE; i++) {
  const token = await issuer.sign({}, { sub: crypto.randomUUID() });
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  await fetch(`${base}/me/profile`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ handle: `load.${String(i)}`, country: 'IN', fields: ['imports-customs'], adult: true }),
  });
  await fetch(`${base}/me/consents`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ choices: [{ category: 'memory_personalization', enabled: true }] }),
  });
  tokens.push(token);
}
const ids = (await db.owner.query('SELECT id::text AS id FROM app.questions ORDER BY random() LIMIT 2000')).rows.map(
  r => r.id,
);

const pct = (xs, q) => {
  const s = [...xs].sort((a, b) => a - b);
  return +(s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? 0).toFixed(1);
};

async function run(label, concurrency, request) {
  const latencies = [];
  let errors = 0;
  let n = 0;
  const until = performance.now() + SECONDS * 1000;
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
    rps: Math.round(latencies.length / SECONDS),
    p50: pct(latencies, 0.5),
    p95: pct(latencies, 0.95),
    p99: pct(latencies, 0.99),
    errors,
    rssMB: Math.round(process.memoryUsage().rss / 1e6),
  };
}

const results = [];
try {
  for (const c of LEVELS) {
    results.push(await run('question (visitor)', c, i => fetch(`${base}/questions/${ids[i % ids.length]}`)));
    results.push(
      await run('question (signed in, memory on)', c, (i, w) =>
        fetch(`${base}/questions/${ids[i % ids.length]}`, {
          headers: { authorization: `Bearer ${tokens[w % tokens.length]}` },
        }),
      ),
    );
    results.push(await run('topics next', c, () => fetch(`${base}/knowledge-graph/next?current=travel`)));
    results.push(await run('sitemap (shared read)', c, () => fetch(`${base}/sitemap/questions`)));
  }
  console.log(JSON.stringify({ questions: size, seconds: SECONDS, results }, null, 1));
} finally {
  await app.close();
  await db.close();
}
