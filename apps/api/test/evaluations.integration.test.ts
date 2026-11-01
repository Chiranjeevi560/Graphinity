// The daily measuring job through real Postgres, and each engine's floor and direction.
import { beforeAll, describe, expect, it } from 'vitest';
import {
  evaluateDelayedCvr,
  evaluatePositionBias,
  evaluateRoutingPolicy,
  evaluateUplift,
  MIN_CLICKS,
  MIN_DECISIONS,
  MIN_PER_ARM,
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
  });
});

describe('what each one says', () => {
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
