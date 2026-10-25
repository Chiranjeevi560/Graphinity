// Learned routing against a real database (ADR 0013, migration 0016): what
// each decision records, who can see it, the database's own checks, the
// labels training reads, and serving behind the owner's switch.
import { beforeAll, describe, expect, it } from 'vitest';
import { loadRoutingExamples, purgeOldRouteFactors } from '../src/ml/routing-data.ts';
import { recordPromoted } from '../src/ml/registry.ts';
import { ROUTING, trainRoutingJob } from '../src/ml/training.ts';
import { routeWave, type Ranker } from '../src/routing.ts';
import { FACTOR_ORDER, psiOfVector } from '../src/routing-score.ts';
import { startApp, type TestApp } from './helpers/app.ts';
import { must } from './helpers/must.ts';

let h: TestApp;
let names = 0;

beforeAll(async () => {
  h = await startApp(() => Date.now());
  return h.close;
});

async function member(field: string, joinedDaysAgo = 30, country = 'IN') {
  const p = await h.person();
  names += 1;
  const res = await h.call('POST', '/me/profile', p.token, {
    handle: `learn.${String(names)}`,
    country,
    fields: [field],
    adult: true,
  });
  expect(res.statusCode).toBe(201);
  await h.t.owner.query(`UPDATE app.profiles SET created_at = now() - make_interval(days => $2) WHERE id = $1`, [
    p.id,
    joinedDaysAgo,
  ]);
  return p;
}

async function ask(token: string, field: string, country: string | null = null): Promise<string> {
  const res = await h.call('POST', '/questions', token, {
    title: 'Which documents do I need to renew a work visa?',
    field,
    country,
  });
  expect(res.statusCode).toBe(201);
  return must(res.json<{ question: { id: string } }>().question.id);
}

const factorsOf = async (questionId: string) =>
  (
    await h.t.owner.query<{
      profile_id: string;
      factors: number[];
      factors_version: number;
      explore: boolean;
      wave: number;
      model_version: number | null;
      ranking_version: number;
    }>(
      `SELECT f.profile_id, f.factors, f.factors_version, f.explore, f.wave, f.model_version, r.ranking_version
       FROM app.route_factors f JOIN app.routes r USING (question_id, profile_id) WHERE f.question_id = $1`,
      [questionId],
    )
  ).rows;

describe('what each routing decision records', () => {
  it('keeps every factor the decision saw, for every person asked', async () => {
    const asker = await member('travel');
    for (let i = 0; i < 6; i++) await member('jobs-careers');
    await member('jobs-careers', 2); // a newcomer, for the explore place
    const q = await ask(asker.token, 'jobs-careers');
    const asked = await h.t.database.asSystem(tx => routeWave(tx, q, 1, 5));
    const rows = await factorsOf(q);
    expect(rows.map(r => r.profile_id).sort()).toEqual([...asked].sort());
    for (const r of rows) {
      expect(r.factors).toHaveLength(FACTOR_ORDER.length);
      expect(r.factors.every(x => x >= 0 && x <= 1)).toBe(true);
      expect(r).toMatchObject({ factors_version: 1, wave: 1, model_version: null, ranking_version: 1 });
    }
    expect(rows.filter(r => r.explore)).toHaveLength(1);
  });

  it('is out of reach of everyone but the server’s own jobs, including the person asked', async () => {
    const asker = await member('travel');
    const person = await member('cars-vehicles');
    const q = await ask(asker.token, 'cars-vehicles');
    expect(await h.t.database.asSystem(tx => routeWave(tx, q, 1, 1))).toEqual([person.id]);
    // They can read their route, but not what it was decided on.
    const own = await h.t.database.withUser(person.id, tx =>
      tx.query('SELECT count(*)::int AS n FROM app.routes WHERE question_id = $1', [q]),
    );
    expect(own.rows).toEqual([{ n: 1 }]);
    const factors = await h.t.database.withUser(person.id, tx =>
      tx.query('SELECT count(*)::int AS n FROM app.route_factors WHERE question_id = $1', [q]),
    );
    expect(factors.rows).toEqual([{ n: 0 }]);
    await expect(
      h.t.database.withUser(person.id, tx =>
        tx.query(
          `INSERT INTO app.route_factors (question_id, profile_id, factors_version, factors, explore, wave)
           VALUES ($1, $2, 1, $3, false, 1)`,
          [q, person.id, FACTOR_ORDER.map(() => 0.5)],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });
});

describe('the database’s own checks', () => {
  async function bareRoute(rankingVersion = 1) {
    const asker = await member('travel');
    const person = await member('food-cooking');
    const q = await ask(asker.token, 'food-cooking');
    await h.t.owner.query(
      'INSERT INTO app.routes (question_id, profile_id, wave, ranking_version) VALUES ($1, $2, 1, $3)',
      [q, person.id, rankingVersion],
    );
    return { q, person: person.id };
  }
  const insert = (
    r: { q: string; person: string },
    factors: unknown,
    extra: { explore?: boolean; model?: number } = {},
  ) =>
    h.t.owner.query(
      `INSERT INTO app.route_factors (question_id, profile_id, factors_version, factors, explore, wave, model_version)
       VALUES ($1, $2, 1, $3::double precision[], $4, 1, $5)`,
      [r.q, r.person, factors, extra.explore ?? false, extra.model ?? null],
    );

  it('refuses vectors of the wrong length, outside [0, 1], not a number, or with a gap', async () => {
    const r = await bareRoute();
    const ok = FACTOR_ORDER.map(() => 0.5);
    await expect(insert(r, ok.slice(1))).rejects.toMatchObject({ code: '23514' });
    await expect(insert(r, [...ok.slice(1), 1.5])).rejects.toMatchObject({ code: '23514' });
    await expect(insert(r, `{${[...ok.slice(1), 'NaN'].join(',')}}`)).rejects.toMatchObject({ code: '23514' });
    await expect(insert(r, `{${[...ok.slice(1), 'NULL'].join(',')}}`)).rejects.toMatchObject({ code: '23514' });
    await expect(insert(r, ok)).resolves.toMatchObject({ rowCount: 1 });
  });

  it('keeps the route’s record and the factors’ model in agreement, and the newcomer place on Ψ', async () => {
    const ok = FACTOR_ORDER.map(() => 0.5);
    const psiRoute = await bareRoute(1);
    await expect(insert(psiRoute, ok, { model: 1 })).rejects.toThrow();
    const learnedRoute = await bareRoute(2);
    await expect(insert(learnedRoute, ok)).rejects.toMatchObject({ code: '23514' });
    // A model version that isn't in the registry is refused too.
    await expect(insert(learnedRoute, ok, { model: 999 })).rejects.toMatchObject({ code: '23503' });
    await expect(insert(await bareRoute(1), ok, { explore: true, model: 1 })).rejects.toThrow();
  });

  it('goes when the route goes, and after 180 days', async () => {
    const r = await bareRoute();
    await insert(
      r,
      FACTOR_ORDER.map(() => 0.5),
    );
    await h.t.owner.query('DELETE FROM app.routes WHERE question_id = $1', [r.q]);
    expect((await h.t.owner.query('SELECT 1 FROM app.route_factors WHERE question_id = $1', [r.q])).rowCount).toBe(0);
    const old = await bareRoute();
    await insert(
      old,
      FACTOR_ORDER.map(() => 0.5),
    );
    await h.t.owner.query(
      "UPDATE app.route_factors SET recorded_at = now() - interval '181 days' WHERE question_id = $1",
      [old.q],
    );
    expect(await purgeOldRouteFactors(h.t.database)).toBeGreaterThanOrEqual(1);
    expect((await h.t.owner.query('SELECT 1 FROM app.route_factors WHERE question_id = $1', [old.q])).rowCount).toBe(0);
  });
});

describe('what training reads', () => {
  it('labels settled exploit routes: answered, helped (picked or marked), and whether the asker judged', async () => {
    const field = 'parenting-schools';
    const asker = await member('travel');
    const people = [await member(field), await member(field), await member(field)];
    const q = await ask(asker.token, field);
    const asked = await h.t.database.asSystem(tx => routeWave(tx, q, 1, 3));
    expect(asked).toHaveLength(3);
    const answerOf = async (p: { token: string }) => {
      const res = await h.call('POST', `/questions/${q}/answers`, p.token, {
        body: 'I renewed mine at the regional office with the passport and two photos.',
      });
      expect(res.statusCode, res.body).toBe(201);
      return must(res.json<{ answer: { id: string } }>().answer.id);
    };
    const [picked, marked] = [await answerOf(must(people[0])), await answerOf(must(people[1]))];
    expect((await h.call('PUT', `/questions/${q}/selection`, asker.token, { answerId: picked })).statusCode).toBe(200);
    expect((await h.call('POST', `/answers/${marked}/helpful`, asker.token)).statusCode).toBeLessThan(300);
    // Not settled yet: nothing to learn from.
    expect((await loadRoutingExamples(h.t.database)).examples.filter(e => e.questionId === q)).toEqual([]);
    // Asked 15 days ago, routed then, answered the next day, judged within the 14-day horizon.
    await h.t.owner.query("UPDATE app.questions SET created_at = now() - interval '15 days' WHERE id = $1", [q]);
    await h.t.owner.query("UPDATE app.routes SET routed_at = now() - interval '15 days' WHERE question_id = $1", [q]);
    await h.t.owner.query("UPDATE app.answers SET created_at = now() - interval '14 days' WHERE question_id = $1", [q]);
    // The database keeps a pick's own time on any update; a test backdates it around that rule.
    await h.t.owner.query('ALTER TABLE app.selections DISABLE TRIGGER selections_check');
    await h.t.owner.query("UPDATE app.selections SET selected_at = now() - interval '13 days' WHERE question_id = $1", [
      q,
    ]);
    await h.t.owner.query('ALTER TABLE app.selections ENABLE TRIGGER selections_check');
    await h.t.owner.query(
      `UPDATE app.helpful_marks SET marked_at = now() - interval '13 days'
       WHERE answer_id IN (SELECT id FROM app.answers WHERE question_id = $1)`,
      [q],
    );
    const examples = (await loadRoutingExamples(h.t.database)).examples.filter(e => e.questionId === q);
    expect(examples).toHaveLength(3);
    const labels = examples.map(e => [e.responded, e.helped, e.judged]).sort();
    expect(labels).toEqual(
      [
        [false, false, true],
        [true, true, true],
        [true, true, true],
      ].sort(),
    );
    expect(examples.every(e => e.askerId === asker.id && Math.round(e.askerAgeDays) === 15)).toBe(true);
  });

  it('counts an answer given more than 7 days after asking as no answer', async () => {
    const field = 'government-services';
    const asker = await member('travel');
    const late = await member(field);
    const q = await ask(asker.token, field);
    await h.t.database.asSystem(tx => routeWave(tx, q, 1, 1));
    await h.call('POST', `/questions/${q}/answers`, late.token, {
      body: 'I renewed mine at the regional office with the passport and two photos.',
    });
    await h.t.owner.query("UPDATE app.questions SET created_at = now() - interval '20 days' WHERE id = $1", [q]);
    await h.t.owner.query("UPDATE app.routes SET routed_at = now() - interval '20 days' WHERE question_id = $1", [q]);
    const examples = (await loadRoutingExamples(h.t.database)).examples.filter(e => e.questionId === q);
    expect(examples).toEqual([expect.objectContaining({ responded: false, helped: false })]);
  });

  it('freezes labels at 14 days, leaves out hidden answers, and reads the newest routes first', async () => {
    const field = 'health-hospitals';
    const asker = await member('travel');
    const [late, spam] = [await member(field), await member(field)];
    await member(field, 2); // a newcomer: their place is ranked with a bonus, so never learned from
    const q = await ask(asker.token, field);
    expect(await h.t.database.asSystem(tx => routeWave(tx, q, 1, 3))).toHaveLength(3);
    const answer = async (p: { token: string }) =>
      must(
        (
          await h.call('POST', `/questions/${q}/answers`, p.token, {
            body: 'I renewed mine at the regional office with the passport and two photos.',
          })
        ).json<{ answer: { id: string } }>().answer.id,
      );
    const lateAnswer = await answer(late);
    const spamAnswer = await answer(spam);
    await h.t.owner.query(`INSERT INTO app.decisions (answer_id, decision) VALUES ($1, 'remove')`, [spamAnswer]);
    await h.t.owner.query("UPDATE app.questions SET created_at = now() - interval '30 days' WHERE id = $1", [q]);
    await h.t.owner.query("UPDATE app.routes SET routed_at = now() - interval '30 days' WHERE question_id = $1", [q]);
    await h.t.owner.query("UPDATE app.answers SET created_at = now() - interval '29 days' WHERE question_id = $1", [q]);
    // Marked helpful on day 20: past the horizon, so it doesn't count, and the asker judged nothing in time.
    expect((await h.call('POST', `/answers/${lateAnswer}/helpful`, asker.token)).statusCode).toBeLessThan(300);
    await h.t.owner.query("UPDATE app.helpful_marks SET marked_at = now() - interval '10 days' WHERE answer_id = $1", [
      lateAnswer,
    ]);
    const rows = (await loadRoutingExamples(h.t.database)).examples.filter(e => e.questionId === q);
    expect(rows.map(e => [e.responded, e.helped, e.judged]).sort()).toEqual(
      [
        [false, false, false],
        [true, false, false],
      ].sort(),
    );
    // The cap keeps the newest question, not the oldest.
    const newest = (await loadRoutingExamples(h.t.database, 1)).examples[0]?.questionId ?? '0';
    const all = (await loadRoutingExamples(h.t.database)).examples.map(e => Number(e.questionId));
    expect(Number(newest)).toBe(Math.max(...all));
  });

  it('skips with too little settled history, and records a run as the routing model', async () => {
    expect(await trainRoutingJob(h.t.database)).toMatchObject({ status: 'skipped', reason: /settled routes/ });
    const outcome = await trainRoutingJob(h.t.database, {
      minRoutes: 1,
      run: input => {
        expect(input.since).toBeNull();
        expect(input.examples.length).toBeGreaterThan(0);
        return Promise.resolve({
          decision: {
            promote: false,
            reason: 'only 1 different askers in judgeable held-out questions; 30 needed',
            askers: 1,
            strata: 0,
            difference: null,
            candidateAuc: 0,
            psiAuc: 0,
            servingAuc: null,
          },
          params: { lambdaAvailability: 1, lambdaQuality: 1, constant: [], trustLevels: 0, converged: true },
          dataset: { trainingRoutes: 1, heldOutRoutes: 0, trainingQuestions: 1, modelRankedRoutes: 0 },
          metrics: { candidateAuc: 0, psiAuc: 0, askers: 1, strata: 0, trainMs: 0 },
          baseline: { kind: 'psi', version: null, psiAuc: 0, servingAuc: null },
          artifact: null,
        });
      },
    });
    expect(outcome).toMatchObject({ status: 'rejected', version: 1 });
    // A rejection that measured nothing (here: too few askers) must not move the judging window:
    // otherwise no later question could ever be both settled and newer, and the gate locks shut.
    const seen: Array<number | null> = [];
    // New data since the last run (the fingerprint skip would otherwise stop it).
    const freshData = () =>
      h.t.owner.query(
        `UPDATE app.ml_models SET dataset = dataset || '{"fingerprint": "older"}' WHERE name = 'routing'`,
      );
    await freshData();
    await trainRoutingJob(h.t.database, {
      minRoutes: 1,
      run: input => {
        seen.push(input.since);
        return Promise.reject(new Error('stop here'));
      },
    }).catch(() => undefined);
    expect(seen).toEqual([null]);
    // One that measured a difference does.
    await h.t.owner.query(
      `UPDATE app.ml_models SET metrics = metrics || '{"difference": {"mean": 0, "low": -0.1, "high": 0.1}}'
       WHERE name = 'routing' AND version = 1`,
    );
    await freshData();
    await trainRoutingJob(h.t.database, {
      minRoutes: 1,
      run: input => {
        seen.push(input.since);
        return Promise.reject(new Error('stop here'));
      },
    }).catch(() => undefined);
    expect(seen[1]).toEqual(expect.any(Number));
  });
});

describe('serving a learned model', () => {
  it('ranks exploit places by it, records which model ranked them, and leaves the newcomer place to Ψ', async () => {
    const field = 'business-startups';
    const asker = await member('travel');
    const regulars = [];
    // Half live in the question's country, half don't: Ψ prefers the first half.
    for (let i = 0; i < 6; i++) regulars.push(await member(field, 30, i % 2 ? 'IN' : 'KE'));
    const newcomerHere = await member(field, 2, 'IN');
    const newcomerAway = await member(field, 2, 'KE');
    const version = await h.t.database.asSystem(async () =>
      recordPromoted(
        h.t.database,
        {
          name: ROUTING,
          algorithm: 'two-stage-bayesian-logistic',
          params: {},
          dataset: { fingerprint: 'test' },
          metrics: {},
          baseline: {},
          reason: 'test',
        },
        Buffer.from('{}'),
      ),
    );
    // A ranker that prefers whoever Ψ likes least: the order must follow it, not Ψ.
    const ranker: Ranker = { version, score: f => 1 - psiOfVector(f), predicted: f => 1 - psiOfVector(f) };
    const qPsi = await ask(asker.token, field, 'IN');
    const byPsi = await h.t.database.asSystem(tx => routeWave(tx, qPsi, 1, 3));
    await h.t.owner.query('DELETE FROM app.routes WHERE question_id = $1', [qPsi]);
    const qLearned = await ask(asker.token, field, 'IN');
    const byModel = await h.t.database.asSystem(tx => routeWave(tx, qLearned, 1, 3, ranker));
    expect(byModel).not.toEqual(byPsi);
    // Ψ prefers members in the question's country; the reversed ranker must choose the others,
    // which Ψ itself ranked last: it ranks the whole pool, not Ψ's shortlist.
    const away = new Set<string>([...regulars.filter((_, i) => i % 2 === 0).map(p => p.id), newcomerAway.id]);
    const exploitPicks = (await factorsOf(qLearned)).filter(r => !r.explore).map(r => r.profile_id);
    expect(exploitPicks.length).toBeGreaterThan(0);
    expect(exploitPicks.every(id => away.has(id))).toBe(true);
    expect(byPsi.filter(id => away.has(id))).toEqual([]);
    const rows = await factorsOf(qLearned);
    for (const r of rows)
      expect(r).toMatchObject(
        r.explore ? { model_version: null, ranking_version: 1 } : { model_version: version, ranking_version: 2 },
      );
    expect(rows.some(r => r.explore)).toBe(true);
    // The newcomer place went to the newcomer in the question's country, as Ψ would choose:
    // the reversed ranker must not reach it.
    expect(rows.filter(r => r.explore).map(r => r.profile_id)).toEqual([newcomerHere.id]);
  });

  it('still spreads attention: with equal model scores, the person asked less today goes first', async () => {
    const field = 'watches-luxury';
    const asker = await member('travel');
    const [x, y] = [await member(field), await member(field)];
    // Ties go to the lower id, so load the lower one: only the dampener can make it lose.
    const [busy, free] = x.id < y.id ? [x, y] : [y, x];
    for (let i = 0; i < 2; i++) {
      const other = await ask(asker.token, 'travel');
      await h.t.owner.query('INSERT INTO app.routes (question_id, profile_id, wave) VALUES ($1, $2, 1)', [
        other,
        busy.id,
      ]);
    }
    const version = await recordPromoted(
      h.t.database,
      {
        name: ROUTING,
        algorithm: 'two-stage-bayesian-logistic',
        params: {},
        dataset: { fingerprint: 'load' },
        metrics: {},
        baseline: {},
        reason: 'test',
      },
      Buffer.from('{}'),
    );
    const q = await ask(asker.token, field);
    expect(
      await h.t.database.asSystem(tx => routeWave(tx, q, 1, 1, { version, score: () => 0.5, predicted: () => 0.5 })),
    ).toEqual([free.id]);
  });
});
