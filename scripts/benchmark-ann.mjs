#!/usr/bin/env node
// Benchmarks the meaning index (ADR 0015) exactly as production builds it:
// pgvector HNSW over halfvec(${D}), cosine, m = 24, ef_construction = 200, on
// vectors from Graphinity's own text model (128 dimensions, zero-padded to
// 768 as served). Against exact search (a sequential scan), it measures
// recall@10 and latency for several ef_search values, plus build time, index
// and table size, and the cost of adding rows to a live index.
//
//   node scripts/benchmark-ann.mjs [rows...]   (default 10000 100000; needs `npm run db:start`)
//   DIMS=128 stores the model's own 128 dimensions (migration 0021) instead of 768 padded;
//   M sets the index's m (default 24). Recall is measured at 10 and at 50, what search asks for.
//
// A scratch database is created and dropped; nothing else is touched.
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { seededRandom } from '../apps/api/src/ml/linalg.ts';
import { embedText, trainTextEmbedding } from '../apps/api/src/ml/text-embedding.ts';

const adminUrl = readFileSync(new URL('../.local/test.env', import.meta.url), 'utf8')
  .split('\n')
  .find(l => l.startsWith('TEST_DATABASE_ADMIN_URL='))
  ?.slice('TEST_DATABASE_ADMIN_URL='.length);
if (!adminUrl) throw new Error('Run `npm run db:start` first (no .local/test.env).');
const urlFor = name => {
  const u = new URL(adminUrl);
  u.pathname = `/${name}`;
  return u.toString();
};

// Questions shaped like Graphinity's: a topic, an item, a place, Zipf filler.
const random = seededRandom(1);
const lexicon = Array.from({ length: 5000 }, (_, i) => `w${i}`);
const zipf = () => lexicon[Math.floor(lexicon.length ** random()) - 1] ?? 'w0';
const topics = ['customs duty on', 'visa for', 'rent for', 'repair of', 'price of', 'import of'];
const text = () =>
  `${topics[Math.floor(random() * topics.length)]} item${Math.floor(random() * 2000)} at city${Math.floor(
    random() * 300,
  )} ${Array.from({ length: 6 }, zipf).join(' ')}`;
const model = trainTextEmbedding(Array.from({ length: 20000 }, text), { dims: 128 });
const D = Number(process.env.DIMS ?? 768);
const M = Number(process.env.M ?? 24);
const vec = t => {
  const v = embedText(model, t);
  return `[${[...v, ...new Array(D - v.length).fill(0)].map(x => x.toFixed(6)).join(',')}]`;
};

const pct = (xs, q) => +[...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(q * xs.length))].toFixed(2);
const admin = new pg.Client({ connectionString: adminUrl });
await admin.connect();
const sizes = process.argv.slice(2).map(Number).filter(Boolean);
for (const rows of sizes.length ? sizes : [10_000, 100_000]) {
  const dbName = `graphinity_bench_ann_${rows}_${D}_${M}`;
  await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
  await admin.query(`CREATE DATABASE ${dbName}`);
  const db = new pg.Client({ connectionString: urlFor(dbName) });
  await db.connect();
  try {
    await db.query('CREATE EXTENSION vector');
    await db.query(`CREATE TABLE q (id int PRIMARY KEY, embedding halfvec(${D}) NOT NULL)`);
    for (let start = 0; start < rows; start += 1000) {
      const ids = [];
      const vs = [];
      for (let i = start; i < Math.min(rows, start + 1000); i++) {
        ids.push(i);
        vs.push(vec(text()));
      }
      await db.query(`INSERT INTO q SELECT * FROM unnest($1::int[], $2::halfvec(${D})[])`, [ids, vs]);
    }
    await db
      .query('SET maintenance_work_mem = $1', ['512MB'])
      .catch(() => db.query("SET maintenance_work_mem = '512MB'"));
    let t = performance.now();
    await db.query(
      `CREATE INDEX q_hnsw ON q USING hnsw (embedding halfvec_cosine_ops) WITH (m = ${M}, ef_construction = 200)`,
    );
    const buildMs = Math.round(performance.now() - t);
    const size = (await db.query(`SELECT pg_relation_size('q_hnsw') AS index, pg_table_size('q') AS table`)).rows[0];
    const queries = Array.from({ length: 200 }, () => vec(text()));
    // Exact answers: a sequential scan computes every distance.
    await db.query('SET enable_indexscan = off');
    const exact = [];
    const exactMs = [];
    for (const qv of queries) {
      t = performance.now();
      const r = await db.query(`SELECT id FROM q ORDER BY embedding <=> $1::halfvec(${D}) LIMIT 50`, [qv]);
      exactMs.push(performance.now() - t);
      exact.push({ at10: new Set(r.rows.slice(0, 10).map(x => x.id)), at50: new Set(r.rows.map(x => x.id)) });
    }
    await db.query('SET enable_indexscan = on');
    const results = [];
    for (const ef of [40, 80, 100, 160, 200, 400]) {
      await db.query(`SET hnsw.ef_search = ${ef}`);
      const ms = [];
      let found10 = 0;
      let found50 = 0;
      for (const [i, qv] of queries.entries()) {
        t = performance.now();
        const r = await db.query(`SELECT id FROM q ORDER BY embedding <=> $1::halfvec(${D}) LIMIT 50`, [qv]);
        ms.push(performance.now() - t);
        found10 += r.rows.slice(0, 10).filter(x => exact[i].at10.has(x.id)).length;
        found50 += r.rows.filter(x => exact[i].at50.has(x.id)).length;
      }
      results.push({
        efSearch: ef,
        recallAt10: +(found10 / (queries.length * 10)).toFixed(4),
        recallAt50: +(found50 / (queries.length * 50)).toFixed(4),
        p50: pct(ms, 0.5),
        p95: pct(ms, 0.95),
      });
    }
    // Adding rows to a live index (what every new question does).
    const extra = Array.from({ length: 1000 }, () => vec(text()));
    t = performance.now();
    for (const [i, v] of extra.entries()) await db.query(`INSERT INTO q VALUES ($1, $2::halfvec(${D}))`, [rows + i, v]);
    const insertMs = (performance.now() - t) / extra.length;
    console.log(
      JSON.stringify({
        rows,
        dims: D,
        m: M,
        buildMs,
        indexMB: +(Number(size.index) / 1e6).toFixed(1),
        tableMB: +(Number(size.table) / 1e6).toFixed(1),
        exactMs: { p50: pct(exactMs, 0.5), p95: pct(exactMs, 0.95) },
        hnsw: results,
        insertWithIndexMs: +insertMs.toFixed(2),
      }),
    );
  } finally {
    await db.end();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
  }
}
await admin.end();
