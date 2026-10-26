#!/usr/bin/env node
// Benchmarks knowledge recommendations v3 against v2 (ADR 0016) on a real
// migrated database seeded with a world of known interests: questions in six
// topics (mapped to real fields), 200 items and 50 places; people who each
// care about two (topic, place) pairs, chose those topics as profile fields,
// opened questions about them and searched for them; and experts who answer
// questions in their own (topic, place). Each person's three most recent
// opens are held out: a recommender is judged by whether it would have put
// them in the 20 it shows (Recall@20, NDCG@20, per person, 99% paired
// bootstrap over people). v2 is run as it shipped (its SQL, reproduced
// below); v3 through apps/api/src/recommendations/feed.ts, whole and with each
// new source removed (ablation).
//
//   node scripts/benchmark-recommendations-v3.mjs [questions] [people]   (default 20000 300)
//
// Synthetic: it shows whether each source finds what people with these
// interests open next; real reading isn't this tidy.
import { readFileSync } from 'node:fs';
import { vectorLiteral } from '../apps/api/src/embeddings.ts';
import { seededRandom } from '../apps/api/src/ml/linalg.ts';
import { ownEmbedderFromArtifact } from '../apps/api/src/ml/own-embedder.ts';
import { serializeModel, trainTextEmbedding } from '../apps/api/src/ml/text-embedding.ts';
import { ALL_SOURCES, recommend } from '../apps/api/src/recommendations/feed.ts';
import { createSearchEngine } from '../apps/api/src/search/engine.ts';
import { ndcgAt, pairedDifference, recallAt } from '../apps/api/src/search/metrics.ts';
import { createTestDatabase } from '../apps/api/test/helpers/database.ts';

process.env.TEST_DATABASE_ADMIN_URL ??= readFileSync(new URL('../.local/test.env', import.meta.url), 'utf8')
  .split('\n')
  .find(l => l.startsWith('TEST_DATABASE_ADMIN_URL='))
  ?.slice('TEST_DATABASE_ADMIN_URL='.length);

const QUESTIONS = Number(process.argv[2] ?? 20_000);
const PEOPLE = Number(process.argv[3] ?? 300);
const TOPICS = [
  { field: 'imports-customs', word: 'duty', title: (g, p) => `customs duty on a ${g} at ${p}` },
  { field: 'visas-immigration', word: 'visa', title: (g, p) => `work visa for a ${g} seller in ${p}` },
  { field: 'housing-renting', word: 'rent', title: (g, p) => `shop rent for a ${g} store in ${p}` },
  { field: 'phones-gadgets', word: 'repair', title: (g, p) => `${g} repair shops in ${p}` },
  { field: 'shopping', word: 'price', title: (g, p) => `${g} price at markets in ${p}` },
  { field: 'travel', word: 'travel', title: (g, p) => `travelling with a ${g} to ${p}` },
];
const PLACES = 50;
const ITEMS = 200;
const OPENS = 10;
const HELD_OUT = 3;

const r = seededRandom(7);
const pick = n => Math.floor(r() * n);
const questions = Array.from({ length: QUESTIONS }, (_, i) => {
  const t = pick(TOPICS.length);
  const g = `item${String(pick(ITEMS))}`;
  const p = `city${String(pick(PLACES))}`;
  return { i, t, p, title: `${TOPICS[t].title(g, p)} ${String(i)}`.padEnd(15, '.'), days: 1 + r() * 150 };
});
const model = trainTextEmbedding(questions.map(q => q.title));
const embedder = ownEmbedderFromArtifact(serializeModel(model), 1);

const db = await createTestDatabase();
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
try {
  await db.owner.query("SET session_replication_role = 'replica'");
  const asker = uuid(1);
  await db.owner.query(
    "INSERT INTO app.profiles (id, handle, country, adult_confirmed_at, created_at) VALUES ($1, 'bench.asker', 'IN', now(), '2020-01-01')",
    [asker],
  );
  // Questions, with their meaning.
  await db.owner.query('DROP INDEX app.question_embeddings_128');
  const ids = [];
  for (let s = 0; s < questions.length; s += 1000) {
    const batch = questions.slice(s, s + 1000);
    const vectors = await embedder.embed(batch.map(q => q.title));
    const { rows } = await db.owner.query(
      `WITH qs AS (
         INSERT INTO app.questions (asker_id, field, title, created_at)
         SELECT $1, f, t, now() - d * interval '1 day' FROM unnest($2::text[], $3::text[], $4::float8[]) WITH ORDINALITY AS x(f, t, d, n)
         ORDER BY n RETURNING id
       ), numbered AS (SELECT id, row_number() OVER (ORDER BY id) AS n FROM qs),
       stored AS (
         INSERT INTO app.question_embeddings (question_id, model, embedding)
         SELECT numbered.id, $6, v.v::extensions.halfvec FROM numbered JOIN unnest($5::text[]) WITH ORDINALITY AS v(v, n) ON v.n = numbered.n
       )
       SELECT id::text AS id FROM numbered ORDER BY id`,
      [
        asker,
        batch.map(q => TOPICS[q.t].field),
        batch.map(q => q.title),
        batch.map(q => q.days),
        vectors.map(vectorLiteral),
        embedder.model,
      ],
    );
    for (const row of rows) ids.push(row.id);
  }
  questions.forEach((q, k) => (q.id = ids[k]));
  // Experts: one per (topic, place), answering about half its questions.
  let n = 2;
  const answers = { q: [], a: [] };
  for (let t = 0; t < TOPICS.length; t++)
    for (let p = 0; p < PLACES; p++) {
      const id = uuid(n++);
      await db.owner.query(
        "INSERT INTO app.profiles (id, handle, country, adult_confirmed_at, created_at) VALUES ($1, $2, 'IN', now(), '2020-01-01')",
        [id, `expert.${String(t)}.${String(p)}`],
      );
      for (const q of questions)
        if (q.t === t && q.p === `city${String(p)}` && r() < 0.5) {
          answers.q.push(q.id);
          answers.a.push(id);
        }
    }
  await db.owner.query(
    `INSERT INTO app.answers (question_id, answerer_id, body)
     SELECT q, a, 'Did exactly this last year; it took about two weeks and cost less than I feared.' FROM unnest($1::bigint[], $2::uuid[]) AS x(q, a)`,
    [answers.q, answers.a],
  );
  // People: two interests each, fields, opens and searches about them.
  const people = [];
  const versions = (await db.owner.query('SELECT name, policy_version FROM app.consent_categories')).rows;
  const version = Object.fromEntries(versions.map(v => [v.name, v.policy_version]));
  for (let k = 0; k < PEOPLE; k++) {
    const id = uuid(n++);
    const interests = [0, 1].map(() => ({ t: pick(TOPICS.length), p: `city${String(pick(PLACES))}` }));
    await db.owner.query(
      "INSERT INTO app.profiles (id, handle, country, adult_confirmed_at, created_at) VALUES ($1, $2, 'IN', now(), '2020-01-01')",
      [id, `person.${String(k)}`],
    );
    for (const f of new Set(interests.map(i => TOPICS[i.t].field)))
      await db.owner.query('INSERT INTO app.profile_fields (profile_id, field) VALUES ($1, $2)', [id, f]);
    for (const c of ['feed_personalization', 'search_history', 'reading_history'])
      await db.owner.query(
        'INSERT INTO app.user_consent_settings (user_id, category, enabled, policy_version) VALUES ($1, $2, true, $3)',
        [id, c, version[c]],
      );
    const pool = questions.filter(q => interests.some(i => i.t === q.t && i.p === q.p));
    const opened = [];
    while (opened.length < OPENS && opened.length < pool.length) {
      const q = pool[pick(pool.length)];
      if (!opened.includes(q)) opened.push(q);
    }
    const history = opened.slice(0, OPENS - HELD_OUT);
    const heldOut = opened.slice(OPENS - HELD_OUT);
    for (const [j, q] of history.entries())
      await db.owner.query(
        `INSERT INTO app.personal_signal_events (user_id, consent_category, signal_type, subject_id, value, source, occurred_at, expires_at)
         VALUES ($1, 'reading_history', 'question_viewed', $2, '{}'::jsonb, 'user_action', now() - make_interval(mins => $3), now() + interval '300 days')`,
        [id, q.id, 100 - j],
      );
    for (const [j, i] of interests.entries())
      await db.owner.query(
        `INSERT INTO app.personal_signal_events (user_id, consent_category, signal_type, value, source, occurred_at, expires_at)
         VALUES ($1, 'search_history', 'search', jsonb_build_object('query', $2::text, 'field', null), 'user_action',
                 now() - make_interval(mins => $3), now() + interval '300 days')`,
        [id, `${TOPICS[i.t].word} ${i.p}`, 50 - j],
      );
    people.push({ id, heldOut: new Set(heldOut.map(q => q.id)) });
  }
  await db.owner.query("SET session_replication_role = 'origin'");
  await db.owner.query(
    `CREATE INDEX question_embeddings_128 ON app.question_embeddings
     USING hnsw ((embedding::extensions.halfvec(128)) extensions.halfvec_cosine_ops) WITH (m = 24, ef_construction = 200)
     WHERE extensions.vector_dims(embedding) = 128`,
  );
  await db.owner.query('SELECT app.rebuild_search_stats()');
  await db.owner.query('ANALYZE');

  const engine = createSearchEngine({ db: db.database, embedder, speller: null });
  const deps = { db: db.database, engine, meaningModel: () => embedder.model };
  const variants = {
    v2: id => v2(id),
    v3: id => recommend(deps, id).then(x => x.recommendations.map(rec => rec.id)),
    // "Similar to a question you opened" by words (BM25 on its title) instead of meaning.
    'v3 reading by words': id =>
      recommend({ ...deps, meaningModel: () => null }, id).then(x => x.recommendations.map(rec => rec.id)),
    'v3 personal only': id =>
      recommend(deps, id, ['search', 'co_answer']).then(x => x.recommendations.map(rec => rec.id)),
    ...Object.fromEntries(
      ['search', 'reading', 'co_answer', 'field', 'recent'].map(s => [
        `v3 without ${s}`,
        id =>
          recommend(
            deps,
            id,
            ALL_SOURCES.filter(x => x !== s),
          ).then(x => x.recommendations.map(rec => rec.id)),
      ]),
    ),
  };
  const judged = {};
  const ms = {};
  for (const [name, run] of Object.entries(variants)) {
    judged[name] = [];
    ms[name] = [];
    for (const p of people) {
      const t = performance.now();
      const list = await run(p.id);
      ms[name].push(performance.now() - t);
      judged[name].push({
        user: p.id,
        relevance: list.map(id => (p.heldOut.has(id) ? 1 : 0)),
        totalRelevant: p.heldOut.size,
      });
    }
  }
  const mean = (qs, f) => qs.reduce((s, q) => s + f(q), 0) / qs.length;
  const recall = q => recallAt(q.relevance, 20, q.totalRelevant);
  const ndcg = q =>
    ndcgAt(
      q.relevance,
      20,
      Array.from({ length: q.totalRelevant }, () => 1),
    );
  const pct = (xs, q) => +[...xs].sort((a, b) => a - b)[Math.floor(q * (xs.length - 1))].toFixed(1);
  const round = x => +x.toFixed(4);
  const report = Object.fromEntries(
    Object.keys(variants).map(k => [
      k,
      {
        recall20: round(mean(judged[k], recall)),
        ndcg20: round(mean(judged[k], ndcg)),
        p50Ms: pct(ms[k], 0.5),
        p95Ms: pct(ms[k], 0.95),
      },
    ]),
  );
  const diff = (a, b) => {
    const d = pairedDifference(judged[a], judged[b], recall);
    return { mean: round(d.mean), low: round(d.low), high: round(d.high) };
  };
  console.log(
    JSON.stringify(
      {
        questions: QUESTIONS,
        people: PEOPLE,
        answers: answers.q.length,
        report,
        v3MinusV2Recall: diff('v3', 'v2'),
        searchAdds: diff('v3', 'v3 without search'),
        readingAdds: diff('v3', 'v3 without reading'),
        coAnswerAdds: diff('v3', 'v3 without co_answer'),
        fieldAdds: diff('v3', 'v3 without field'),
        recentAdds: diff('v3', 'v3 without recent'),
        personalOnlyMinusV3: diff('v3 personal only', 'v3'),
        readingByWordsMinusV3: diff('v3 reading by words', 'v3'),
        readingByWordsMinusNoReading: diff('v3 reading by words', 'v3 without reading'),
      },
      null,
      1,
    ),
  );
} finally {
  await db.close();
}

/** v2's fusion, as it shipped (apps/api/src/recommendation-ranking.ts at feed-rrf-v2). */
function rankRecommendations(candidates, limit) {
  const reciprocal = rank => (rank === null ? 0 : 1 / (60 + rank));
  return candidates
    .map(item => ({
      item,
      score:
        reciprocal(item.ranks.field) +
        reciprocal(item.ranks.search) +
        reciprocal(item.ranks.reading) +
        reciprocal(item.ranks.recent),
    }))
    .sort((a, b) => b.score - a.score || (b.item.id < a.item.id ? -1 : b.item.id > a.item.id ? 1 : 0))
    .slice(0, limit);
}

/** v2 exactly as it shipped (apps/api/src/routes/recommendations.ts at feed-rrf-v2). */
async function v2(userId) {
  return db.database.withUser(userId, async q => {
    const { rows } = await q.query(
      `WITH active_events AS MATERIALIZED (
         SELECT e.consent_category, e.signal_type, e.value, e.subject_id, e.occurred_at
         FROM app.personal_signal_events e
         WHERE e.user_id = $1 AND e.expires_at > now()
           AND ((e.consent_category = 'search_history' AND $2::boolean AND e.signal_type = 'question_precheck')
             OR (e.consent_category = 'reading_history' AND $3::boolean AND e.signal_type = 'question_viewed'))
         ORDER BY e.occurred_at DESC LIMIT 50
       ),
       viewed AS MATERIALIZED (
         SELECT e.subject_id::bigint AS id, q.field, q.title, e.occurred_at
         FROM active_events e JOIN app.questions q ON q.id = e.subject_id::bigint
         WHERE e.consent_category = 'reading_history' AND NOT app.is_question_hidden(q.id)
       ),
       candidate_ids AS MATERIALIZED (
         SELECT field_candidates.id FROM (
           SELECT q.id FROM app.questions q
           JOIN app.profile_fields pf ON pf.profile_id = $1 AND pf.field = q.field
           WHERE q.created_at > now() - interval '180 days' AND NOT app.is_question_hidden(q.id)
           ORDER BY q.created_at DESC, q.id DESC LIMIT 100
         ) field_candidates
         UNION
         SELECT match.id FROM active_events e
         CROSS JOIN LATERAL (
           SELECT q.id FROM app.questions q
           WHERE e.consent_category = 'search_history'
             AND q.search @@ replace(plainto_tsquery('english', e.value ->> 'query')::text, ' & ', ' | ')::tsquery
             AND q.created_at > now() - interval '180 days' AND NOT app.is_question_hidden(q.id)
           ORDER BY ts_rank_cd(q.search, replace(plainto_tsquery('english', e.value ->> 'query')::text, ' & ', ' | ')::tsquery) DESC,
                    q.created_at DESC, q.id DESC LIMIT 20
         ) match
         UNION
         SELECT q.id FROM viewed v
         CROSS JOIN LATERAL (
           SELECT recent.id FROM app.questions recent
           WHERE recent.field = v.field AND recent.id <> v.id
             AND recent.created_at > now() - interval '180 days' AND NOT app.is_question_hidden(recent.id)
           ORDER BY recent.created_at DESC, recent.id DESC LIMIT 25
         ) q
         UNION
         SELECT recent_candidates.id FROM (
           SELECT q.id FROM app.questions q
           WHERE q.created_at > now() - interval '30 days' AND NOT app.is_question_hidden(q.id)
           ORDER BY q.created_at DESC, q.id DESC LIMIT 100
         ) recent_candidates
       ),
       eligible AS MATERIALIZED (
         SELECT q.id, q.title, q.field, q.created_at,
                EXISTS (SELECT 1 FROM app.profile_fields pf WHERE pf.profile_id = $1 AND pf.field = q.field) AS field_match,
                COALESCE((
                  SELECT max(ts_rank_cd(q.search, replace(plainto_tsquery('english', e.value ->> 'query')::text, ' & ', ' | ')::tsquery))
                  FROM active_events e
                  WHERE e.consent_category = 'search_history'
                    AND q.search @@ replace(plainto_tsquery('english', e.value ->> 'query')::text, ' & ', ' | ')::tsquery
                ), 0.0) AS search_match,
                COALESCE((
                  SELECT max(ts_rank_cd(q.search, replace(plainto_tsquery('english', v.title)::text, ' & ', ' | ')::tsquery))
                  FROM viewed v WHERE q.search @@ replace(plainto_tsquery('english', v.title)::text, ' & ', ' | ')::tsquery
                ), 0.0) AS reading_match
         FROM candidate_ids c JOIN app.questions q ON q.id = c.id
         WHERE q.asker_id <> $1 AND NOT app.is_question_hidden(q.id)
           AND NOT EXISTS (SELECT 1 FROM app.answers a WHERE a.question_id = q.id AND a.answerer_id = $1)
           AND NOT EXISTS (SELECT 1 FROM viewed v WHERE v.id = q.id)
       ),
       ranked_sources AS (
         SELECT e.*,
                CASE WHEN field_match THEN row_number() OVER (ORDER BY field_match DESC, created_at DESC, id DESC)::int END AS field_rank,
                CASE WHEN search_match > 0 THEN row_number() OVER (ORDER BY search_match DESC, created_at DESC, id DESC)::int END AS search_rank,
                CASE WHEN reading_match > 0 THEN row_number() OVER (ORDER BY reading_match DESC, created_at DESC, id DESC)::int END AS reading_rank,
                row_number() OVER (ORDER BY created_at DESC, id DESC)::int AS recent_rank
         FROM eligible e
       )
       SELECT id::text, field_rank AS "fieldRank", search_rank AS "searchRank", reading_rank AS "readingRank",
              recent_rank AS "recentRank" FROM ranked_sources`,
      [userId, true, true],
    );
    return rankRecommendations(
      rows.map(x => ({
        ...x,
        ranks: { field: x.fieldRank, search: x.searchRank, reading: x.readingRank, recent: x.recentRank },
      })),
      20,
    ).map(x => x.item.id);
  });
}
