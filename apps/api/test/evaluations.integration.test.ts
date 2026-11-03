// The daily measuring job through real Postgres, and each engine's floor and direction.
import { beforeAll, describe, expect, it } from 'vitest';
import {
  evaluateCommercialIntent,
  evaluateDelayedCvr,
  evaluateExplorationEffect,
  evaluateMultiTask,
  evaluatePositionBias,
  evaluatePriceElasticity,
  evaluateTwoTower,
  evaluateRoutingPolicy,
  evaluateUplift,
  MIN_CLICKS,
  MIN_DECISIONS,
  MIN_ANSWERED,
  MIN_PER_ARM,
  MIN_QUESTIONS,
  MIN_READERS,
  MIN_SEARCH_ROWS,
  runModelEvaluations,
} from '../src/platform/evaluations.ts';
import type { DelayedExample } from '../src/ml/delayed-feedback.ts';
import { startApp, type TestApp } from './helpers/app.ts';
import { must } from './helpers/must.ts';

let h: TestApp;
beforeAll(async () => {
  h = await startApp(() => Date.now());
  return h.close;
});

describe('floors', () => {
  it('reports nothing below each floor, rather than a number that means nothing', () => {
    const click: DelayedExample = { x: Float64Array.of(1, 0), delay: null, elapsed: 40 };
    expect(evaluateDelayedCvr(Array<DelayedExample>(MIN_CLICKS - 1).fill(click))).toBeNull();
    expect(evaluatePositionBias(Array(MIN_SEARCH_ROWS - 1).fill({ item: 'a', rank: 1, clicked: false }))).toBeNull();
    expect(
      evaluateRoutingPolicy(
        Array(MIN_DECISIONS - 1).fill({
          reward: 0,
          propensity: 1,
          examination: 1,
          target: 1,
          predicted: 0,
          targetValue: 0,
        }),
      ),
    ).toBeNull();
    const units = Array.from({ length: MIN_PER_ARM * 3 }, () => ({ x: [0], treated: true, y: 1 }));
    expect(evaluateUplift(units)).toBeNull();
    const question = { title: 'Where to buy a bike at a fair price?', body: '', field: 'travel' };
    expect(evaluateCommercialIntent(Array(MIN_QUESTIONS - 1).fill(question))).toBeNull();
    // Seven days, or eight at one price: no slope.
    expect(evaluatePriceElasticity(days(7, 2))).toBeNull();
    expect(evaluatePriceElasticity(Array(20).fill({ field: 'travel', price: 1, quantity: 100 }))).toBeNull();
  });
});

/** Days of ad sales whose volume falls as price rises, with a slope of -`slope`. */
function days(n: number, slope: number, field = 'travel') {
  return Array.from({ length: n }, (_, i) => {
    const price = 1 + i * 0.25;
    return { field, price, quantity: 1000 * price ** -slope };
  });
}

describe('what each one says', () => {
  it('counts a question as commercial only when two signals agree', () => {
    const buying = { title: 'Where to buy a used bike at a fair price in Pune?', body: '', field: 'travel' };
    const passing = {
      title: 'Is the old fort open on Mondays this month?',
      body: 'I had to buy a ticket.',
      field: 'travel',
    };
    const result = must(
      evaluateCommercialIntent([...Array<typeof buying>(30).fill(buying), ...Array<typeof passing>(30).fill(passing)]),
    );
    expect(result.questions).toBe(60);
    expect(result.purchase).toBe(0.5);
    expect(result.hiring).toBe(0);
  });

  it('finds how sales fall as price rises, per field, with an interval around it', () => {
    const result = must(
      evaluatePriceElasticity([...days(20, 1.5), ...days(20, 0.5, 'education'), ...days(3, 1, 'food')]),
    );
    expect(must(result['travel.slope'])).toBeCloseTo(-1.5, 6);
    expect(must(result['education.slope'])).toBeCloseTo(-0.5, 6);
    expect(must(result['travel.low'])).toBeLessThanOrEqual(must(result['travel.slope']));
    expect(must(result['travel.high'])).toBeGreaterThanOrEqual(must(result['travel.slope']));
    expect(result['travel.days']).toBe(20);
    // Too few days in a field: left out, not guessed.
    expect(result['food.slope']).toBeUndefined();
  });

  it('corrects a conversion rate upward when many clicks are too recent to have sold', () => {
    // A true rate of 30%, sales about 5 days after the click, and half the clicks only a day old.
    const examples: DelayedExample[] = Array.from({ length: 1000 }, (_, i) => {
      const old = i < 500;
      const sells = i % 10 < 3;
      return {
        x: Float64Array.of(1, 0),
        delay: sells && old ? 5 : null,
        elapsed: old ? 40 : 1,
      };
    });
    const result = must(evaluateDelayedCvr(examples));
    expect(must(result.naiveRate)).toBeCloseTo(0.15, 2);
    expect(must(result.correctedRate)).toBeGreaterThan(must(result.naiveRate));
    expect(must(result.correctedRate)).toBeLessThan(0.45);
  });

  it('finds that lower ranks are opened less for the same result', () => {
    const logs = Array.from({ length: 2000 }, (_, i) => {
      const rank = (i % 5) + 1;
      return { item: `q${String(i % 7)}`, rank, clicked: i % (rank * 2) === 0 };
    });
    const { examination } = must(evaluatePositionBias(logs));
    expect(must(examination[0])).toBeGreaterThan(must(examination[4]));
  });

  it('values no exploration by the decisions that policy would have made', () => {
    const log = Array.from({ length: 400 }, (_, i) => {
      const explored = i % 4 === 0;
      return {
        reward: explored ? 0 : 1,
        propensity: explored ? 0.25 : 0.75,
        examination: 1,
        target: explored ? 0 : 1,
        predicted: 0.5,
        targetValue: 0.5,
      };
    });
    const result = must(evaluateRoutingPolicy(log));
    expect(must(result.logged)).toBeCloseTo(0.75, 5);
    expect(must(result.noExplorationIps)).toBeCloseTo(1, 1);
  });

  it('separates what exploring costs from the doubt that chose whom to explore', () => {
    // Exploration goes to people the model rates low, and costs 0.1 in answering on top of that.
    const random = (() => {
      let s = 7;
      return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32;
    })();
    const log = Array.from({ length: 4000 }, () => {
      const predicted = random();
      const explored = random() < 0.8 - 0.6 * predicted;
      const p = 0.2 + 0.6 * predicted - (explored ? 0.1 : 0);
      return {
        reward: random() < p ? 1 : 0,
        propensity: 0.5,
        examination: 1,
        target: explored ? 0 : 1,
        predicted,
        targetValue: predicted,
      };
    });
    const naive =
      log.filter(d => d.target === 0).reduce((a, d) => a + d.reward, 0) / log.filter(d => d.target === 0).length -
      log.filter(d => d.target === 1).reduce((a, d) => a + d.reward, 0) / log.filter(d => d.target === 1).length;
    const result = must(evaluateExplorationEffect(log));
    expect(naive).toBeLessThan(-0.2);
    expect(must(result.effect)).toBeGreaterThan(-0.15);
    expect(must(result.effect)).toBeLessThan(-0.05);
    expect(must(result.low)).toBeLessThan(-0.1);
    expect(must(result.high)).toBeGreaterThan(-0.1);
    // One arm too thin: nothing.
    expect(evaluateExplorationEffect(log.map(d => ({ ...d, target: 1 })))).toBeNull();
  });

  it('compares two-tower retrieval with most-opened on each person’s latest open', () => {
    // Ten groups of readers, each reading its own eight questions: taste a popularity list can't see.
    const opens = Array.from({ length: 400 }, (_, u) =>
      Array.from({ length: 6 }, (_, k) => ({
        user: `u${String(u)}`,
        item: `g${String(u % 10)}-${String((u + k * 3) % 8)}`,
      })),
    ).flat();
    const result = must(evaluateTwoTower(opens));
    expect(result.people).toBe(400);
    expect(must(result.recallTwoTower)).toBeGreaterThan(must(result.recallPopular) + 0.2);
    // Too few people who opened two different questions: nothing.
    expect(evaluateTwoTower(opens.filter(o => Number(o.user.slice(1)) < MIN_READERS - 1))).toBeNull();
  });

  it('learns answering and being picked together, and scores both on people it held out', () => {
    const random = (() => {
      let s = 11;
      return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32;
    })();
    // Answering follows the first factor; being picked, among those who answer, the second.
    const routed = Array.from({ length: 2000 }, () => {
      const factors = Array.from({ length: 9 }, () => random());
      const answered = random() < 0.1 + 0.7 * (factors[0] ?? 0);
      return { factors, answered, picked: answered && random() < 0.1 + 0.8 * (factors[1] ?? 0) };
    });
    const result = must(evaluateMultiTask(routed));
    expect(result.routed).toBe(2000);
    expect(must(result.mmoeAnswered)).toBeGreaterThan(0.7);
    expect(must(result.mmoePicked)).toBeGreaterThan(0.65);
    expect(must(result.sharedAnswered)).toBeGreaterThan(0.7);
    // Too few answers to learn picks from: nothing.
    expect(
      evaluateMultiTask(routed.map((r, i) => ({ ...r, answered: i < MIN_ANSWERED - 1, picked: false }))),
    ).toBeNull();
  });

  it('scores uplift on units the model did not fit', () => {
    const rows = Array.from({ length: 600 }, (_, i) => {
      const x = (i % 10) / 10;
      const treated = i % 4 < 2;
      return { x: [x], treated, y: treated ? x : 0 };
    });
    const result = must(evaluateUplift(rows));
    expect(result.units).toBe(600);
    expect(must(result.qini)).toBeGreaterThan(0);
  });
});

describe('the job', () => {
  it('records what has enough data, once a day, for the owner only', async () => {
    const p = await h.person();
    await h.t.database.withUser(p.id, async q => {
      await expect(q.query("INSERT INTO app.model_evaluations (name, metrics) VALUES ('x', '{}')")).rejects.toThrow();
    });
    expect(
      await h.t.database.withUser(p.id, async q => (await q.query('SELECT 1 FROM app.model_evaluations')).rowCount),
    ).toBe(0);

    const { rows } = await h.t.owner.query<{ id: string }>(
      `INSERT INTO app.exp_layers (name, salt_secret) VALUES ('evaluations', 'salt') RETURNING layer_id::text AS id`,
    );
    const exp = must(
      (
        await h.t.owner.query<{ id: string }>(
          `INSERT INTO app.exp_definitions (layer_id, name, bucket_start, bucket_end, status)
           VALUES ($1, 'evaluated', 0, 100, 'running') RETURNING exp_id::text AS id`,
          [must(rows[0]).id],
        )
      ).rows[0],
    ).id;
    await h.t.owner.query(
      `INSERT INTO app.exp_unit_metrics (exp_id, unit_id, arm, pre_experiment_covariate_x, post_metric_y)
       SELECT $1, 'unit-unit-unit-unit-unit-' || g, CASE WHEN g % 2 = 0 THEN 'treatment' ELSE 'control' END, g % 5, g % 3
       FROM generate_series(1, 400) g`,
      [exp],
    );
    expect(await runModelEvaluations(h.t.database, Date.now())).toBe(1);
    const saved = await h.t.owner.query<{ name: string }>('SELECT name FROM app.model_evaluations');
    expect(saved.rows.map(r => r.name)).toEqual([`uplift:${exp}`]);
    // Within the day, nothing more.
    expect(await runModelEvaluations(h.t.database, Date.now())).toBe(0);
  });
});

describe('the job, on questions', () => {
  it('reads what share of public questions is commercial, and leaves hidden ones out', async () => {
    const own = await startApp(() => Date.now());
    try {
      const asker = (await own.person()).id;
      // A profile needs a field in the same transaction.
      await own.t.owner.query('BEGIN');
      await own.t.owner.query(
        `INSERT INTO app.profiles (id, handle, country, adult_confirmed_at) VALUES ($1, 'intent.asker', 'IN', now())`,
        [asker],
      );
      await own.t.owner.query("INSERT INTO app.profile_fields (profile_id, field) VALUES ($1, 'travel')", [asker]);
      await own.t.owner.query('COMMIT');
      // An established account: new ones may post only three questions on their first day.
      await own.t.owner.query("UPDATE app.profiles SET created_at = now() - interval '60 days' WHERE id = $1", [asker]);
      await own.t.owner.query(
        `INSERT INTO app.questions (asker_id, field, title)
         SELECT $1, 'travel', CASE WHEN g % 2 = 0 THEN 'Where to buy a rail pass at a fair price, number ' || g
                                   ELSE 'Which ferry runs on Sundays to the island, number ' || g END
         FROM generate_series(1, $2::int) g`,
        [asker, MIN_QUESTIONS],
      );
      // One more buying question, hidden by a moderator: not read.
      const hidden = must(
        (
          await own.t.owner.query<{ id: string }>(
            `INSERT INTO app.questions (asker_id, field, title) VALUES ($1, 'travel', 'Where to buy the cheapest price ticket?')
             RETURNING id::text`,
            [asker],
          )
        ).rows[0],
      ).id;
      await own.t.owner.query(`INSERT INTO app.decisions (question_id, decision) VALUES ($1, 'remove')`, [hidden]);
      expect(await runModelEvaluations(own.t.database, Date.now())).toBe(1);
      const { rows } = await own.t.owner.query<{ metrics: Record<string, number> }>(
        "SELECT metrics FROM app.model_evaluations WHERE name = 'commercial-intent'",
      );
      expect(must(rows[0]).metrics).toMatchObject({ questions: MIN_QUESTIONS, purchase: 0.5 });
    } finally {
      await own.close();
    }
  });
});
