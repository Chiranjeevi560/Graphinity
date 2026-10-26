// The learned search ranking end to end on a real database (ADR 0015 part 6):
// training data as logged, candidates in the registry, the online judge's
// verdicts (promote, reject, roll back), and the route serving and
// interleaving rankers.
import { beforeAll, describe, expect, it } from 'vitest';
import { serializeLambdaMart, trainLambdaMart } from '../src/ml/lambdamart.ts';
import { loadComparable, recordCandidate } from '../src/ml/registry.ts';
import { trainSearchRankerJob } from '../src/ml/training.ts';
import { rankingFeatures } from '../src/search/features.ts';
import { MAX_DAYS, MIN_DECIDED, runSearchJudge } from '../src/search/judge.ts';
import { LONG_READ_MS, loadSearchTraining } from '../src/search/ranker-data.ts';
import { BASELINE_RANKER, SEARCH_RANKER, type Rankers } from '../src/search/rankers.ts';
import { startApp, type TestApp } from './helpers/app.ts';
import { must } from './helpers/must.ts';

let h: TestApp;
let names = 0;
let rankers: Rankers = { production: { id: BASELINE_RANKER, model: null }, challenger: null };
let coin = 0.999;

beforeAll(async () => {
  h = await startApp(() => Date.now(), { searchRandom: () => coin, searchRankers: () => rankers });
  return h.close;
});

async function member(allow = true) {
  const p = await h.person();
  names += 1;
  await h.call('POST', '/me/profile', p.token, {
    handle: `learn.${String(names)}`,
    country: 'IN',
    fields: ['imports-customs'],
    adult: true,
  });
  await h.call('PUT', '/me/consents', p.token, { choices: [{ category: 'search_improvement', enabled: allow }] });
  return p;
}

const model = (everyWordFirst: boolean) => {
  const f = (everyWord: boolean, wordRank: number) =>
    rankingFeatures({ wordRank, meaningRank: null, similarity: null, everyWord, answerCount: 0, answerAgeDays: null });
  // Learns to put every-word results first, or last.
  return trainLambdaMart(
    Array.from({ length: 40 }, () => ({
      features: [f(false, 1), f(true, 1)],
      labels: everyWordFirst ? [0, 1] : [1, 0],
    })),
    { trees: 5, minLeafSize: 1 },
  );
};

const record = {
  algorithm: 'lambdamart-ips',
  params: {},
  dataset: { fingerprint: 'x' },
  metrics: {},
  baseline: {},
  reason: 'test',
};

describe('training data, as logged', () => {
  it('labels long reads 2 and other opens 1, keeps ranked and shown positions, and leaves interleaved searches out', async () => {
    const p = await member();
    const asker = await member(false);
    for (const title of ['Customs duty on a drone at Goa airport?', 'Customs duty and a drone battery at Goa?'])
      await h.call('POST', '/questions', asker.token, { title, field: 'imports-customs' });
    const search = async () =>
      (await h.call('POST', '/search', p.token, { query: 'customs duty drone goa' })).json<{
        searchId: string;
        results: Array<{ id: string }>;
      }>();
    const res = await search();
    await h.call('PUT', `/searches/${res.searchId}/opens/1`, p.token, { dwellMs: LONG_READ_MS });
    await h.call('PUT', `/searches/${res.searchId}/opens/2`, p.token, { dwellMs: 1_000 });
    // An interleaved one, opened too: judged online, never learned from.
    const other = await search();
    await h.call('PUT', `/searches/${other.searchId}/opens/1`, p.token, { dwellMs: LONG_READ_MS });
    await h.t.owner.query("UPDATE app.searches SET experiment = 'rrf-equal-v1/lambdamart:v1' WHERE public_id = $1", [
      other.searchId,
    ]);
    const data = await loadSearchTraining(h.t.database);
    expect(data.searches).toHaveLength(1);
    const mine = data.searches;
    expect(mine[0]?.results.map(r => ({ position: r.position, ranked: r.ranked, label: r.label }))).toEqual([
      { position: 1, ranked: 1, label: 2 },
      { position: 2, ranked: 2, label: 1 },
    ]);
    expect(mine[0]?.user).toMatch(/^[0-9a-f]{16}$/);
    expect(mine[0]?.user).not.toContain(p.id.slice(0, 8));
    expect(data.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    await h.t.owner.query('DELETE FROM app.searches');
  });
});

describe('the registry', () => {
  it('keeps one candidate: a newer one supersedes the older, whose weights go', async () => {
    const v1 = await recordCandidate(h.t.database, { ...record, name: 'test-ranker' }, Buffer.from('a'));
    const v2 = await recordCandidate(h.t.database, { ...record, name: 'test-ranker' }, Buffer.from('b'));
    const { rows } = await h.t.owner.query<{ version: number; status: string; has: boolean }>(
      "SELECT version, status, artifact IS NOT NULL AS has FROM app.ml_models WHERE name = 'test-ranker' ORDER BY version",
    );
    expect(rows).toEqual([
      { version: v1, status: 'rejected', has: false },
      { version: v2, status: 'candidate', has: true },
    ]);
    // And the database refuses a second one even if code forgot.
    await expect(
      h.t.owner.query(
        "INSERT INTO app.ml_models (name, version, algorithm, status) VALUES ('test-ranker', 99, 'lambdamart-ips', 'candidate')",
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('lets a version’s weights be removed, never replaced', async () => {
    const v = await recordCandidate(h.t.database, { ...record, name: 'fixed-ranker' }, Buffer.from('w'));
    await expect(
      h.t.database.asSystem(q =>
        q.query(
          "UPDATE app.ml_models SET artifact = 'other', artifact_sha256 = repeat('b', 64) WHERE name = 'fixed-ranker' AND version = $1",
          [v],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('a passing training run becomes a candidate, not the serving version', async () => {
    const outcome = await trainSearchRankerJob(h.t.database, {
      minSearches: 0,
      run: () =>
        Promise.resolve({
          decision: { promote: true, reason: 'test', difference: { mean: 0.05, low: 0.02, high: 0.08 } },
          params: {},
          dataset: { trainingSearches: 1, heldOutSearches: 1, heldOutPeople: 1 },
          metrics: { candidate: 0.5, trainMs: 1 },
          baseline: { kind: 'logged', version: null, score: 0.45 },
          artifact: new Uint8Array(serializeLambdaMart(model(true))),
        }),
    });
    expect(outcome.status).toBe('candidate');
    const v = await loadComparable(h.t.database, SEARCH_RANKER, 14);
    expect(v.production).toBeNull();
    expect(v.candidate?.status).toBe('candidate');
  });
});

/** Interleaved searches as logged: the challenger's result opened `bShare` of the time. */
async function interleaved(experiment: string, people: number, perPerson: number, bShare: number) {
  const users: string[] = [];
  for (let i = 0; i < people; i++) users.push((await member()).id);
  const q = (await h.t.owner.query<{ id: string }>('SELECT id::text AS id FROM app.questions ORDER BY id LIMIT 2'))
    .rows;
  const [qa, qb] = [must(q[0]).id, must(q[1]).id];
  await h.t.owner.query("SET session_replication_role = 'replica'");
  try {
    let n = 0;
    for (const user of users)
      for (let k = 0; k < perPerson; k++) {
        const { rows } = await h.t.owner.query<{ id: string }>(
          `INSERT INTO app.searches (user_id, consent_version, query, ranker, experiment)
           VALUES ($1, 1, 'customs duty', 'x', $2) RETURNING id::text AS id`,
          [user, experiment],
        );
        const id = must(rows[0]).id;
        await h.t.owner.query(
          `INSERT INTO app.search_results (search_id, position, ranked_position, team, question_id, every_word, answer_count)
           VALUES ($1, 1, 1, 'a', $2, false, 0), ($1, 2, 2, 'b', $3, false, 0)`,
          [id, qa, qb],
        );
        const bWins = n++ % 100 < bShare * 100;
        await h.t.owner.query('INSERT INTO app.search_opens (search_id, position) VALUES ($1, $2)', [
          id,
          bWins ? 2 : 1,
        ]);
      }
  } finally {
    await h.t.owner.query("SET session_replication_role = 'origin'");
  }
}

describe('the online judge', () => {
  it('promotes a candidate that wins, keeps the replaced version as a challenger, and rolls back if it wins', async () => {
    const v = must((await loadComparable(h.t.database, SEARCH_RANKER, 14)).candidate);
    expect((await runSearchJudge(h.t.database)).action).toBe('none');
    await interleaved(`rrf-equal-v1/lambdamart:v${String(v.version)}`, 40, Math.ceil(MIN_DECIDED / 40), 0.8);
    const won = await runSearchJudge(h.t.database);
    expect(won).toMatchObject({ action: 'promote', version: v.version });
    const after = await loadComparable(h.t.database, SEARCH_RANKER, 14);
    expect(after.production?.version).toBe(v.version);
    expect(after.candidate).toBeNull();
    // A second candidate, then promoted: the first becomes the retired challenger.
    const v2 = await recordCandidate(
      h.t.database,
      { ...record, name: SEARCH_RANKER },
      serializeLambdaMart(model(false)),
    );
    await interleaved(
      `lambdamart:v${String(v.version)}/lambdamart:v${String(v2)}`,
      40,
      Math.ceil(MIN_DECIDED / 40),
      0.8,
    );
    expect(await runSearchJudge(h.t.database)).toMatchObject({ action: 'promote', version: v2 });
    // Now the replaced version wins against it: rolled back.
    await interleaved(
      `lambdamart:v${String(v2)}/lambdamart:v${String(v.version)}`,
      40,
      Math.ceil(MIN_DECIDED / 40),
      0.8,
    );
    expect(await runSearchJudge(h.t.database)).toMatchObject({ action: 'restore', version: v.version });
    const rolled = await loadComparable(h.t.database, SEARCH_RANKER, 14);
    expect(rolled.production?.version).toBe(v.version);
    const { rows } = await h.t.owner.query<{ status: string; reason: string }>(
      'SELECT status, reason FROM app.ml_models WHERE name = $1 AND version = $2',
      [SEARCH_RANKER, v2],
    );
    expect(rows[0]).toMatchObject({ status: 'retired' });
    expect(rows[0]?.reason).toMatch(/^rolled back/);
  });

  it('rejects a candidate that loses, or that hasn’t won in time', async () => {
    const prod = must((await loadComparable(h.t.database, SEARCH_RANKER, 14)).production);
    // Retired challengers age out of the window first, so a candidate is what's judged.
    await h.t.owner.query("UPDATE app.ml_models SET retired_at = now() - interval '30 days' WHERE status = 'retired'");
    const loser = await recordCandidate(
      h.t.database,
      { ...record, name: SEARCH_RANKER },
      serializeLambdaMart(model(false)),
    );
    await interleaved(
      `lambdamart:v${String(prod.version)}/lambdamart:v${String(loser)}`,
      40,
      Math.ceil(MIN_DECIDED / 40),
      0.2,
    );
    expect(await runSearchJudge(h.t.database)).toMatchObject({ action: 'reject', version: loser });
    const slow = await recordCandidate(
      h.t.database,
      { ...record, name: SEARCH_RANKER },
      serializeLambdaMart(model(true)),
    );
    expect((await runSearchJudge(h.t.database)).action).toBe('none');
    await h.t.owner.query(
      `UPDATE app.ml_models SET created_at = now() - interval '${String(MAX_DAYS + 1)} days' WHERE version = $1 AND name = $2`,
      [slow, SEARCH_RANKER],
    );
    expect(await runSearchJudge(h.t.database)).toMatchObject({ action: 'reject', version: slow });
    const { rows } = await h.t.owner.query<{ status: string; has: boolean }>(
      'SELECT status, artifact IS NOT NULL AS has FROM app.ml_models WHERE name = $1 AND version = ANY($2::int[]) ORDER BY version',
      [SEARCH_RANKER, [loser, slow]],
    );
    expect(rows).toEqual([
      { status: 'rejected', has: false },
      { status: 'rejected', has: false },
    ]);
  });
});

describe('serving', () => {
  it('orders by the serving model, and interleaves with a challenger only for recorded searches', async () => {
    const asker = await member(false);
    const plain = (
      await h.call('POST', '/questions', asker.token, {
        title: 'Is there duty on a used phone bought in Pune?',
        field: 'imports-customs',
      })
    ).json<{ question: { id: string } }>().question.id;
    const all = (
      await h.call('POST', '/questions', asker.token, {
        title: 'Customs duty pune phone: what did you pay?',
        field: 'imports-customs',
      })
    ).json<{ question: { id: string } }>().question.id;
    const query = { query: 'customs duty pune phone' };
    const ids = async (token?: string) =>
      (await h.call('POST', '/search', token, query)).json<{ results: Array<{ id: string }>; searchId?: string }>();
    rankers = { production: { id: 'lambdamart:v7', model: model(false) }, challenger: null };
    const visitor = await ids();
    // The model learned every-word results go last: it served.
    expect(visitor.results.map(r => r.id).indexOf(all)).toBeGreaterThan(visitor.results.map(r => r.id).indexOf(plain));
    const searcher = await member();
    rankers = {
      production: { id: 'lambdamart:v7', model: model(false) },
      challenger: { id: 'lambdamart:v8', model: model(true) },
    };
    coin = 0; // interleave, and team a picks first
    const recordedSearch = await ids(searcher.token);
    const { rows } = await h.t.owner.query<{ ranker: string; experiment: string | null; teams: string[] }>(
      `SELECT s.ranker, s.experiment, array_agg(r.team ORDER BY r.position) AS teams
       FROM app.searches s JOIN app.search_results r ON r.search_id = s.id WHERE s.public_id = $1 GROUP BY s.id`,
      [must(recordedSearch.searchId)],
    );
    expect(rows[0]).toMatchObject({ ranker: 'lambdamart:v7', experiment: 'lambdamart:v7/lambdamart:v8' });
    expect(rows[0]?.teams.slice(0, 2)).toEqual(['a', 'b']);
    // A visitor's results are never interleaved: the serving model alone.
    expect((await ids()).results.map(r => r.id)).toEqual(visitor.results.map(r => r.id));
    rankers = { production: { id: BASELINE_RANKER, model: null }, challenger: null };
    coin = 0.999;
  });
});
