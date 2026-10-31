// What the engines do with too little, empty or awkward input: answer plainly, never NaN or a throw.
import { describe, expect, it } from 'vitest';
import { fitDelayedFeedback } from '../src/ml/delayed-feedback.ts';
import { fitIsotonic } from '../src/ml/isotonic.ts';
import { fitPositionBias } from '../src/ml/counterfactual.ts';
import { fitXLearner } from '../src/ml/uplift.ts';
import { successiveHalving } from '../src/ml/tuning.ts';
import { evaluate, variance } from '../src/experiments/stats.ts';
import { assign, type Experiment } from '../src/experiments/assign.ts';
import { fitHoltWinters, forecastWithIntervals } from '../src/commerce/forecast.ts';
import { associationRules, fpGrowth } from '../src/commerce/basket.ts';
import { resolveEntities } from '../src/commerce/entity.ts';
import { nextItems, emptyTransitions, observeSession } from '../src/kg/session-graph.ts';
import { buildGraph, embed, initSage } from '../src/kg/graphsage.ts';
import { trustInto } from '../src/kg/trust-flow.ts';
import { TDigest } from '../src/olap/sketches.ts';
import { verifyFaithfulness } from '../src/intelligence/faithfulness.ts';
import { verifyReceiptText } from '../src/intelligence/media.ts';
import { runPlan, type Tool } from '../src/intelligence/orchestrator.ts';

describe('with too little to go on', () => {
  it('statistics stay finite', () => {
    const none = { x: [], y: [] };
    const r = evaluate(none, none, [0.5, 0.5]);
    expect(r.srm.mismatch).toBe(false);
    expect(r.effect?.lift).toBe(0);
    expect(r.effect?.varianceReduction).toBe(0);
    expect(variance([1])).toBe(0);
    expect(fitIsotonic([], []).x.length).toBe(0);
    expect(fitXLearner([]).propensity).toBe(0.5);
    expect(fitPositionBias([{ item: 'a', rank: 9, clicked: true }], 2).examination[0]).toBeCloseTo(1, 9);
    expect(fitDelayedFeedback([], 2).wc.length).toBe(2);
  });
  it('forecasts of a short series still answer, with an honest wide interval', () => {
    const f = forecastWithIntervals([5, 6, 7], 2);
    expect(f[0]?.value).toBeGreaterThanOrEqual(0);
    expect(f[0]?.high).toBe(Infinity);
    expect(f[0]?.low).toBe(0);
    expect(fitHoltWinters([]).model.level).toBe(0);
  });
  it('baskets, sessions and graphs handle nothing', () => {
    expect(fpGrowth([], 1)).toEqual([]);
    expect(associationRules([], 1)).toEqual([]);
    expect(associationRules([{ items: ['a', 'b'], support: 1 }], 10, 1e-3, 1e9)).toEqual([]);
    expect(resolveEntities([]).size).toBe(0);
    const t = emptyTransitions();
    observeSession(t, ['a', 'a', 'b']);
    expect(nextItems(t, 'a', 'b')).toEqual([]);
    expect(
      embed(
        initSage(4, 1, () => 0.5),
        buildGraph(1, new Float32Array(2), 2, []),
      ).length,
    ).toBe(4);
    expect(trustInto(2, [], [0], [1])).toBe(0);
    expect(new TDigest().toBytes().length).toBe(0);
  });
});

describe('awkward input', () => {
  it('a single-arm experiment gives everyone that arm; weights rounding short fall to the last', () => {
    const e: Experiment = { id: 'e', bucketStart: 0, bucketEnd: 10_000, arms: [{ name: 'only', weight: 0.0000001 }] };
    expect(assign('u', 's', [e])?.arm).toBe('only');
    const bare: Experiment = { id: 'e', bucketStart: 0, bucketEnd: 10_000, arms: [] };
    expect(assign('u', 's', [bare])?.arm).toBe('control');
  });
  it('halving with one configuration or no configurations ends at once', async () => {
    const one = await successiveHalving([{ a: 1 }], () => 2);
    expect(one.best.loss).toBe(2);
    const none = await successiveHalving([], () => 2);
    expect(none.best.loss).toBe(Infinity);
  });
  it('a summary with no sources keeps nothing; a receipt in another format reads what it can', () => {
    expect(verifyFaithfulness('Something is true.', []).kept).toEqual([]);
    expect(verifyReceiptText('Duty paid: $1,000 on 3/4/26 tariff 8517').dutyTotal).toBe(1000);
  });
  it('a plan step reading a failed step gets nothing, not a crash', async () => {
    const tools = new Map<string, Tool<null>>([
      ['bad', { name: 'bad', readOnly: true, timeoutMs: 100, run: () => Promise.reject(new Error('timeout')) }],
      ['see', { name: 'see', readOnly: true, timeoutMs: 100, run: i => Promise.resolve(i.v === undefined) }],
    ]);
    const r = await runPlan(
      [
        { id: 'a', tool: 'bad', input: {} },
        { id: 'b', tool: 'see', input: { v: { $from: 'a' }, plain: 1, none: null } },
      ],
      tools,
      null,
    );
    expect(r.get('a')).toMatchObject({ ok: false, error: 'timeout' });
    expect(r.get('b')?.ok).toBe(true);
  });
});
