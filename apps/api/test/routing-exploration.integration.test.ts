// Exploration against a real database (ADR 0014, migration 0017): what a
// decided last place records, the database's own checks and weekly cap,
// and automatic retirement of a serving model that falls short.
import pg from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import { lastRejectedAt, recordPromoted } from '../src/ml/registry.ts';
import { loadHistories } from '../src/ml/routing-data.ts';
import { scoreRoutingAt, trainRoutingModel, type RoutingModel } from '../src/ml/routing-model.ts';
import { monitorRouting } from '../src/ml/routing-monitor.ts';
import { simulateRouting } from '../src/ml/routing-simulator.ts';
import { ROUTING } from '../src/ml/training.ts';
import { routeWave } from '../src/routing.ts';
import { FACTOR_ORDER } from '../src/routing-score.ts';
import { startApp, type TestApp } from './helpers/app.ts';
import { must } from './helpers/must.ts';

let h: TestApp;
let names = 0;
let version = 0;
let model: RoutingModel;

beforeAll(async () => {
  h = await startApp(() => Date.now());
  const trained = trainRoutingModel(
    simulateRouting({ questions: 300, world: 'availability', seed: 1 }).map((e, i) => ({
      ...e,
      profileId: `p${String(i % 200)}`,
    })),
  );
  // People who differ beyond their factors: someone never asked is genuinely unknown.
  model = {
    ...trained,
    availability: { ...trained.availability, personSd: 0.8 },
    quality: { ...trained.quality, personSd: 0.8 },
  };
  version = await recordPromoted(
    h.t.database,
    {
      name: ROUTING,
      algorithm: 'two-stage-bayesian-logistic',
      params: {},
      dataset: { fingerprint: 'exploration' },
      metrics: {},
      baseline: {},
      reason: 'test',
    },
    Buffer.from(JSON.stringify(model)),
  );
  return h.close;
  // Trains a model first: longer than the default hook limit under coverage.
}, 120_000);

async function member(field: string, joinedDaysAgo = 30) {
  const p = await h.person();
  names += 1;
  const res = await h.call('POST', '/me/profile', p.token, {
    handle: `explore.${String(names)}`,
    country: 'IN',
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

async function ask(token: string, field: string): Promise<string> {
  const res = await h.call('POST', '/questions', token, {
    title: 'Which documents do I need to renew a work visa?',
    field,
  });
  expect(res.statusCode).toBe(201);
  return must(res.json<{ question: { id: string } }>().question.id);
}

const decisionsOf = async (q: string) =>
  (
    await h.t.owner.query<{
      profile_id: string;
      explore: boolean;
      explore_reason: string | null;
      propensity: number | null;
      predicted: number | null;
      model_version: number | null;
      ranking_version: number;
    }>(
      `SELECT f.profile_id, f.explore, f.explore_reason, f.propensity, f.predicted, f.model_version, r.ranking_version
       FROM app.route_factors f JOIN app.routes r USING (question_id, profile_id) WHERE f.question_id = $1`,
      [q],
    )
  ).rows;

describe('the last place under exploration', () => {
  it('is decided by the procedure, recorded with why and how likely, and replaces the newcomer place', async () => {
    const field = 'jobs-careers';
    const asker = await member('travel');
    for (let i = 0; i < 8; i++) await member(field);
    await member(field, 2);
    const q = await ask(asker.token, field);
    const asked = await h.t.database.asSystem(tx => routeWave(tx, q, 1, 5, null, { version, model }));
    expect(asked).toHaveLength(5);
    const rows = await decisionsOf(q);
    const decided = rows.filter(r => r.explore_reason !== null);
    expect(decided).toHaveLength(1);
    const [d] = decided;
    expect(d).toMatchObject({ explore: false, model_version: version, ranking_version: 2 });
    expect(d?.propensity).toBeGreaterThan(0);
    expect(d?.propensity).toBeLessThanOrEqual(1);
    expect(d?.predicted).toBeGreaterThan(0);
    // No newcomer place: everyone else is an exploit place ranked by Ψ (no learned ranker given).
    expect(rows.filter(r => r.explore)).toEqual([]);
    expect(rows.filter(r => r.explore_reason === null).every(r => r.model_version === null)).toBe(true);
  });

  it('records each route’s prediction at its own wave, which is what calibration checks', async () => {
    const field = 'phones-gadgets';
    const asker = await member('travel');
    for (let i = 0; i < 8; i++) await member(field);
    const q = await ask(asker.token, field);
    await h.t.database.asSystem(tx => routeWave(tx, q, 2, 5, null, { version, model }));
    const rows = (
      await h.t.owner.query<{ factors: number[]; predicted: number | null; explore_reason: string | null }>(
        'SELECT factors, predicted, explore_reason FROM app.route_factors WHERE question_id = $1',
        [q],
      )
    ).rows.filter(r => r.explore_reason !== null);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row?.predicted).toBeCloseTo(scoreRoutingAt(model, row?.factors ?? [], 2), 12);
    expect(row?.predicted).not.toBeCloseTo(scoreRoutingAt(model, row?.factors ?? [], 1), 6);
  });

  it('reads each candidate’s own record: someone who never answers isn’t explored, even with fresh-looking factors', async () => {
    const field = 'shopping';
    const asker = await member('travel');
    const regulars = [];
    for (let i = 0; i < 5; i++) regulars.push(await member(field));
    const silent = await member(field, 200);
    // 60 settled routes, 90 to 150 days ago (past the 60 days the factors look at, inside the
    // 180 days the record keeps): asked, never answered.
    for (let i = 0; i < 60; i++) {
      const old = await ask(asker.token, 'travel');
      await h.t.owner.query(
        'INSERT INTO app.routes (question_id, profile_id, wave, ranking_version) VALUES ($1, $2, 1, 1)',
        [old, silent.id],
      );
      await h.t.owner.query(
        'UPDATE app.routes SET routed_at = now() - make_interval(days => $3) WHERE question_id = $1 AND profile_id = $2',
        [old, silent.id, 90 + i],
      );
      await h.t.owner.query('UPDATE app.questions SET created_at = now() - make_interval(days => $2) WHERE id = $1', [
        old,
        90 + i,
      ]);
      await h.t.owner.query(
        `INSERT INTO app.route_factors (question_id, profile_id, factors_version, factors, explore, wave)
         VALUES ($1, $2, 1, $3, false, 1)`,
        [old, silent.id, FACTOR_ORDER.map(() => 0.5)],
      );
    }
    const wide: RoutingModel = {
      ...model,
      availability: { ...model.availability, personSd: 2 },
      quality: { ...model.quality, personSd: 2 },
    };
    const decisions = [];
    for (let i = 0; i < 3; i++) {
      const q = await ask(asker.token, field);
      await h.t.database.asSystem(tx => routeWave(tx, q, 1, 5, null, { version, model: wide }));
      decisions.push(...(await decisionsOf(q)).filter(r => r.explore_reason !== null));
    }
    expect(decisions).toHaveLength(3);
    expect(decisions.filter(d => d.explore_reason === 'explored' && d.profile_id === silent.id)).toEqual([]);
  });

  it('keeps the newcomer place when exploration is off', async () => {
    const field = 'cars-vehicles';
    const asker = await member('travel');
    for (let i = 0; i < 6; i++) await member(field);
    await member(field, 2);
    const q = await ask(asker.token, field);
    await h.t.database.asSystem(tx => routeWave(tx, q, 1, 5));
    const rows = await decisionsOf(q);
    expect(rows.filter(r => r.explore)).toHaveLength(1);
    expect(rows.every(r => r.explore_reason === null && r.propensity === null)).toBe(true);
  });
});

describe('the database’s own checks', () => {
  async function bareRoute(rankingVersion: number) {
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
    v: { model?: number | null; reason?: string | null; propensity?: number | null; predicted?: number | null },
  ) =>
    h.t.owner.query(
      `INSERT INTO app.route_factors (question_id, profile_id, factors_version, factors, explore, wave,
                                      model_version, explore_reason, propensity, predicted)
       VALUES ($1, $2, 1, $3, false, 1, $4, $5, $6, $7)`,
      [
        r.q,
        r.person,
        FACTOR_ORDER.map(() => 0.5),
        v.model ?? null,
        v.reason ?? null,
        v.propensity ?? null,
        v.predicted ?? null,
      ],
    );

  it('refuses a decision without a propensity, a propensity without a decision, or one not made by a model', async () => {
    await expect(
      insert(await bareRoute(2), { model: version, reason: 'explored', predicted: 0.3 }),
    ).rejects.toMatchObject({
      code: '23514',
    });
    await expect(insert(await bareRoute(2), { model: version, propensity: 0.5, predicted: 0.3 })).rejects.toMatchObject(
      {
        code: '23514',
      },
    );
    await expect(insert(await bareRoute(1), { reason: 'explored', propensity: 0.5 })).rejects.toMatchObject({
      code: '23514',
    });
    await expect(
      insert(await bareRoute(2), { model: version, reason: 'explored', propensity: 1.5, predicted: 0.3 }),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      insert(await bareRoute(2), { model: version, reason: 'explored', propensity: 0.5, predicted: 0.3 }),
    ).resolves.toMatchObject({ rowCount: 1 });
  });

  it('explores no one more than 3 times in 7 days', async () => {
    const person = await member('legal-matters');
    const asker = await member('travel');
    let made = 0;
    const explore = async () => {
      const q = await ask(asker.token, 'legal-matters');
      await h.t.owner.query(
        'INSERT INTO app.routes (question_id, profile_id, wave, ranking_version) VALUES ($1, $2, 1, 2)',
        [q, person.id],
      );
      // The database stamps routed_at and allows 3 a day; spread these over earlier days.
      made++;
      await h.t.owner.query(
        'UPDATE app.routes SET routed_at = now() - make_interval(days => $3) WHERE question_id = $1 AND profile_id = $2',
        [q, person.id, made],
      );
      return insert({ q, person: person.id }, { model: version, reason: 'explored', propensity: 0.3, predicted: 0.2 });
    };
    for (let i = 0; i < 3; i++) await explore();
    await expect(explore()).rejects.toMatchObject({ code: '23514' });
    // A week later the cap has room again.
    await h.t.owner.query(
      "UPDATE app.route_factors SET recorded_at = now() - interval '8 days' WHERE profile_id = $1",
      [person.id],
    );
    await expect(explore()).resolves.toMatchObject({ rowCount: 1 });
  });
});

describe('two routing runs at once', () => {
  it('can’t both explore a person who has room for only one more', async () => {
    const person = await member('study-abroad');
    const asker = await member('travel');
    const routeFor = async (daysAgo: number) => {
      const q = await ask(asker.token, 'study-abroad');
      await h.t.owner.query(
        'INSERT INTO app.routes (question_id, profile_id, wave, ranking_version) VALUES ($1, $2, 1, 2)',
        [q, person.id],
      );
      await h.t.owner.query(
        'UPDATE app.routes SET routed_at = now() - make_interval(days => $3) WHERE question_id = $1 AND profile_id = $2',
        [q, person.id, daysAgo],
      );
      return q;
    };
    const explored = (q: string) =>
      `INSERT INTO app.route_factors (question_id, profile_id, factors_version, factors, explore, wave, model_version,
                                      explore_reason, propensity, predicted)
       VALUES (${q}, '${person.id}', 1, '{${FACTOR_ORDER.map(() => 0.5).join(',')}}', false, 1, ${String(version)}, 'explored', 0.3, 0.2)`;
    for (const d of [1, 2]) await h.t.owner.query(explored(await routeFor(d)));
    const [qa, qb] = [await routeFor(3), await routeFor(4)];
    // Two connections, each in its own transaction, both trying the third.
    const a = new pg.Client({ connectionString: h.t.ownerUrl });
    const b = new pg.Client({ connectionString: h.t.ownerUrl });
    await a.connect();
    await b.connect();
    try {
      await a.query('BEGIN');
      await b.query('BEGIN');
      await a.query(explored(qa));
      // While the first is still open, the second must wait for it, not count past it.
      const second = b.query(explored(qb)).then(
        () => 'inserted',
        (err: unknown) => err,
      );
      const early = await Promise.race([
        second,
        new Promise(resolve =>
          setTimeout(() => {
            resolve('waiting');
          }, 300),
        ),
      ]);
      expect(early).toBe('waiting');
      await a.query('COMMIT');
      expect(await second).toMatchObject({ code: '23514' });
      await b.query('ROLLBACK');
    } finally {
      await a.end();
      await b.end();
    }
  });
});

describe('automatic retirement', () => {
  it('retires a serving model whose predictions fall clearly short, and says why', async () => {
    const field = 'money-tax';
    const asker = await member('travel');
    const people: Array<{ id: string; token: string }> = [];
    for (let i = 0; i < 4; i++) people.push(await member(field));
    // 240 settled, judged routes it predicted at 0.5 each; none helped.
    for (let i = 0; i < 60; i++) {
      const q = await ask(asker.token, field);
      for (const p of people) {
        await h.t.owner.query(
          'INSERT INTO app.routes (question_id, profile_id, wave, ranking_version) VALUES ($1, $2, 1, 2)',
          [q, p.id],
        );
        // Spread over earlier days: the database allows 3 routes a person a day.
        await h.t.owner.query(
          'UPDATE app.routes SET routed_at = now() - make_interval(days => $3) WHERE question_id = $1 AND profile_id = $2',
          [q, p.id, 20 + i],
        );
        await h.t.owner.query(
          `INSERT INTO app.route_factors (question_id, profile_id, factors_version, factors, explore, wave, model_version, predicted)
           VALUES ($1, $2, 1, $3, false, 1, $4, 0.5)`,
          [q, p.id, FACTOR_ORDER.map(() => 0.5), version],
        );
      }
      // The asker judged something (a pick of another answer), so "not helped" means something.
      const other = await member('travel');
      await h.t.owner.query('ALTER TABLE app.answers DISABLE TRIGGER USER');
      const answer = (
        await h.t.owner.query<{ id: string }>(
          'INSERT INTO app.answers (question_id, answerer_id, body) VALUES ($1, $2, $3) RETURNING id::text',
          [q, other.id, 'I renewed mine at the regional office with the passport and two photos.'],
        )
      ).rows[0]?.id;
      await h.t.owner.query('ALTER TABLE app.answers ENABLE TRIGGER USER');
      await h.t.owner.query('ALTER TABLE app.selections DISABLE TRIGGER USER');
      await h.t.owner.query(
        'INSERT INTO app.selections (question_id, answer_id, selected_at) VALUES ($1, $2, now() - make_interval(days => $3))',
        [q, answer, 19 + i],
      );
      await h.t.owner.query('ALTER TABLE app.selections ENABLE TRIGGER USER');
      await h.t.owner.query('UPDATE app.questions SET created_at = now() - make_interval(days => $2) WHERE id = $1', [
        q,
        20 + i,
      ]);
    }
    // Each person's record, as exploration reads it: 60 settled routes, judged, none helped.
    const histories = await h.t.database.asSystem(tx => loadHistories(tx, [must(people[0]).id]));
    expect(histories.get(must(people[0]).id)).toHaveLength(60);
    expect(histories.get(must(people[0]).id)?.every(r => r.judged && !r.helped && !r.responded)).toBe(true);
    const watch = await monitorRouting(h.t.database);
    expect(watch.calibration).toMatchObject({ demote: true, observed: 0 });
    const { rows } = await h.t.owner.query<{ status: string; reason: string }>(
      'SELECT status, reason FROM app.ml_models WHERE name = $1 AND version = $2',
      [ROUTING, version],
    );
    expect(rows).toEqual([{ status: 'retired', reason: expect.stringMatching(/retired, routing uses Ψ/) as unknown }]);
    // The next candidate is judged only on questions asked after this.
    expect(Math.abs(((await lastRejectedAt(h.t.database, ROUTING)) ?? 0) - Date.now())).toBeLessThan(60_000);
  });
});
