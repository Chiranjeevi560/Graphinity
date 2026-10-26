#!/usr/bin/env node
// Benchmarks search (ADR 0015 part 2) end to end through the engine the API
// serves, on a real migrated database: Graphinity's own text model trained
// as the daily job trains it, vectors stored and indexed as production stores
// them (halfvec(768), HNSW), and the same queries run by words alone, by
// meaning alone, and fused.
//
// The task: a held-out question's details are the query; its title is the one
// relevant result, among every question in the database. Held-out questions
// are stored by title only and never seen in training, as the embedding gate
// judges a model. Reports MRR, NDCG@10, Recall@10 with a paired bootstrap:
// word ranking against the one before migration 0020 (ts_rank_cd, every word
// a prefix), fused against each single ranking, and other fusion weights;
// plus the engine's stage latencies.
//
//   node scripts/benchmark-search.mjs [questions...]   (default 10000 100000; needs `npm run db:start`)
//
// Synthetic data (scripts/lib/synthetic-questions.mjs) says how the methods
// compare and scale; it does not predict quality on real posts.
import { createSearchEngine } from '../apps/api/src/search/engine.ts';
import { prefixQuery } from '../apps/api/src/text.ts';
import { pairedDifference, reciprocalRank, score } from '../apps/api/src/search/metrics.ts';
import { SEARCH_POOL } from '../apps/api/src/routes/search.ts';
import { seedSearchDatabase } from './lib/seed-search.mjs';

const QUERIES = Number(process.env.QUERIES ?? 500);
const pct = (xs, q) => {
  const s = [...xs].sort((a, b) => a - b);
  return +s[Math.min(s.length - 1, Math.floor(q * s.length))].toFixed(2);
};
const round = x => +x.toFixed(4);
const judged = (ids, target) => ({
  user: target,
  relevance: ids.slice(0, SEARCH_POOL).map(id => (id === target ? 1 : 0)),
  totalRelevant: 1,
});

// Before migration 0020: ts_rank_cd over every typed word matched as a prefix.
let beforeTimeouts = 0;
async function tsRankPrefix(database, text, pool) {
  const words = prefixQuery(text, 'any');
  if (!words) return [];
  return database
    .withUser(null, async q =>
      (
        await q.query(
          `SELECT q.id::text AS id FROM app.questions q, to_tsquery('english', $1) query
         WHERE q.search @@ query ORDER BY ts_rank_cd(q.search, query) DESC, q.id DESC LIMIT $2`,
          [words, pool],
        )
      ).rows.map(r => r.id),
    )
    .catch(err => {
      // Cancelled by the API's statement timeout: to the person, a failed search.
      if (err.code !== '57014') throw err;
      beforeTimeouts += 1;
      return [];
    });
}

/** Weighted reciprocal rank fusion (k = 60), for comparing weights. */
function rrf(byMeaning, byWords, wMeaning) {
  const score = new Map();
  byMeaning.forEach((id, i) => score.set(id, (score.get(id) ?? 0) + wMeaning / (61 + i)));
  byWords.forEach((id, i) => score.set(id, (score.get(id) ?? 0) + (1 - wMeaning) / (61 + i)));
  return [...score].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

const sizes = process.argv.slice(2).map(Number).filter(Boolean);
for (const size of sizes.length ? sizes : [10_000, 100_000]) {
  const { db, embedder, heldOut, idOf, trainMs, loadMs } = await seedSearchDatabase(size);
  let t;
  try {
    const sizes = (
      await db.owner.query(
        `SELECT pg_relation_size('app.question_embeddings_128') AS index, pg_table_size('app.question_embeddings') AS vectors`,
      )
    ).rows[0];

    const words = createSearchEngine({ db: db.database, embedder: null, speller: null });
    const fused = createSearchEngine({ db: db.database, embedder, speller: null });
    const sample = heldOut.slice(0, QUERIES);
    const runs = { before: [], words: [], meaning: [], fused: [], rrfEqual: [], rrfWordsHeavy: [] };
    const beforeMs = [];
    const timings = { embed: [], words: [], meaning: [], fetch: [], total: [] };
    // The ranking before migration 0020 in a pass of its own: it reads much of the
    // table, and interleaved it would evict the engine's pages from the cache.
    for (const q of sample) {
      t = performance.now();
      runs.before.push(judged(await tsRankPrefix(db.database, q.body, SEARCH_POOL), idOf.get(q.title)));
      beforeMs.push(performance.now() - t);
    }
    for (const q of sample) {
      const target = idOf.get(q.title);
      const w = await words.retrieve({ text: q.body, field: null, pool: SEARCH_POOL });
      const wordIds = w.found.map(f => f.id);
      runs.words.push(judged(wordIds, target));
      t = performance.now();
      const f = await fused.retrieve({ text: q.body, field: null, pool: SEARCH_POOL });
      timings.total.push(performance.now() - t);
      for (const k of ['embed', 'words', 'meaning', 'fetch']) timings[k].push(f.timings[k]);
      runs.fused.push(
        judged(
          f.found.map(x => x.id),
          target,
        ),
      );
      const meaningIds = f.found
        .filter(x => x.meaningRank !== null)
        .sort((a, b) => a.meaningRank - b.meaningRank)
        .map(x => x.id);
      const fusedWordIds = f.found
        .filter(x => x.wordRank !== null)
        .sort((a, b) => a.wordRank - b.wordRank)
        .map(x => x.id);
      runs.meaning.push(judged(meaningIds, target));
      runs.rrfEqual.push(judged(rrf(meaningIds, fusedWordIds, 0.5), target));
      runs.rrfWordsHeavy.push(judged(rrf(meaningIds, fusedWordIds, 0.35), target));
    }
    const scores = Object.fromEntries(
      Object.entries(runs).map(([k, v]) => {
        const s = score(v);
        return [k, { mrr: round(s.mrr), ndcg10: round(s.ndcg10), recall10: round(s.recall10) }];
      }),
    );
    const diff = (a, b, m) => {
      const d = pairedDifference(runs[a], runs[b], m);
      return { mean: round(d.mean), low: round(d.low), high: round(d.high) };
    };
    console.log(
      JSON.stringify({
        questions: size,
        queries: sample.length,
        trainMs,
        loadMs,
        scores,
        wordsMinusBefore: { mrr: diff('words', 'before', q => reciprocalRank(q.relevance)) },
        fusedMinusWords: { mrr: diff('fused', 'words', q => reciprocalRank(q.relevance)) },
        fusedMinusMeaning: { mrr: diff('fused', 'meaning', q => reciprocalRank(q.relevance)) },
        rrfEqualMinusFused: { mrr: diff('rrfEqual', 'fused', q => reciprocalRank(q.relevance)) },
        beforeTimeouts,
        beforeWordsMs: { p50: pct(beforeMs, 0.5), p95: pct(beforeMs, 0.95), p99: pct(beforeMs, 0.99) },
        rssMB: Math.round(process.memoryUsage().rss / 1e6),
        meaningIndexMB: +(Number(sizes.index) / 1e6).toFixed(1),
        vectorTableMB: +(Number(sizes.vectors) / 1e6).toFixed(1),
        latencyMs: Object.fromEntries(
          Object.entries(timings).map(([k, v]) => [k, { p50: pct(v, 0.5), p95: pct(v, 0.95), p99: pct(v, 0.99) }]),
        ),
      }),
    );
  } finally {
    // KEEP=1 leaves the database for diagnosis (printed to stderr); drop it by hand afterwards.
    if (process.env.KEEP) console.error(`kept: ${db.ownerUrl}`);
    else await db.close();
  }
}
// A kept database holds connections open; nothing else is left to do.
if (process.env.KEEP) process.exit(0);
