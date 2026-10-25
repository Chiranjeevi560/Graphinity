// Exploration for routing (ADR 0014): the posterior it draws from, the
// person-level uncertainty, and the decision with its gates and propensity.
import { describe, expect, it } from 'vitest';
import { gaussian, seededRandom } from '../src/ml/linalg.ts';
import { fitLogistic, posteriorCovariance, predict, sigmoid } from '../src/ml/logistic.ts';
import {
  decideLastPlace,
  MIN_PROBABILITY_BETTER,
  NO_HISTORY,
  personHistory,
  personPosterior,
  WEEKLY_EXPLORE_CAP,
  type ExploreCandidate,
  type PersonHistory,
} from '../src/ml/routing-bandit.ts';
import { estimatePersonSd, trainRoutingModel, type RoutingModel } from '../src/ml/routing-model.ts';
import { calibrationVerdict, explorationReport } from '../src/ml/routing-monitor.ts';
import { simulateRouting } from '../src/ml/routing-simulator.ts';
import { FACTOR_ORDER } from '../src/routing-score.ts';

describe('the posterior', () => {
  it('is the inverse of the log-posterior’s curvature, checked by finite differences', () => {
    const random = seededRandom(2);
    const normal = gaussian(random);
    const x = Array.from({ length: 300 }, () => [normal(), normal()]);
    const y = x.map(r => (random() < predict({ weights: [0.3, 1, -0.5] }, r) ? 1 : 0));
    const lambda = 2;
    const model = fitLogistic(x, y, lambda);
    const cov = posteriorCovariance(x, model);
    // Numerical Hessian of −log posterior (intercept with the same sliver of curvature).
    const nll = (w: number[]) =>
      -x.reduce((s, r, i) => {
        const p = predict({ weights: w }, r);
        return s + (y[i] ? Math.log(p) : Math.log(1 - p));
      }, 0) +
      (lambda / 2) * ((w[1] ?? 0) ** 2 + (w[2] ?? 0) ** 2) +
      (1e-6 / 2) * (w[0] ?? 0) ** 2;
    const h = 1e-4;
    const hess = [0, 1, 2].map(a =>
      [0, 1, 2].map(b => {
        const at = (da: number, db: number) => {
          const w = [...model.weights];
          w[a] = (w[a] ?? 0) + da;
          w[b] = (w[b] ?? 0) + db;
          return nll(w);
        };
        return (at(h, h) - at(h, -h) - at(-h, h) + at(-h, -h)) / (4 * h * h);
      }),
    );
    // cov · hess ≈ identity.
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++) {
        const v = [0, 1, 2].reduce((s, k) => s + (cov[i * 3 + k] ?? 0) * (hess[k]?.[j] ?? 0), 0);
        expect(v).toBeCloseTo(i === j ? 1 : 0, 3);
      }
  });

  it('narrows as evidence grows', () => {
    const random = seededRandom(3);
    const normal = gaussian(random);
    const make = (n: number) => {
      const x = Array.from({ length: n }, () => [normal()]);
      const y = x.map(r => (random() < predict({ weights: [0, 1] }, r) ? 1 : 0));
      return posteriorCovariance(x, fitLogistic(x, y, 1))[3] ?? 0;
    };
    expect(make(2000)).toBeLessThan(make(100) / 5);
  });
});

describe('how much people differ beyond their factors', () => {
  const simulate = (tau: number, seed: number) => {
    const random = seededRandom(seed);
    const normal = gaussian(random);
    const people: Array<string | undefined> = [];
    const predictions: number[] = [];
    const labels: number[] = [];
    for (let u = 0; u < 400; u++) {
      const effect = tau * normal();
      for (let r = 0; r < 20; r++) {
        const base = -0.5 + normal() * 0.5;
        people.push(`u${String(u)}`);
        predictions.push(sigmoid(base));
        labels.push(random() < sigmoid(base + effect) ? 1 : 0);
      }
    }
    return { people, predictions, labels };
  };

  it('recovers a known spread, and finds none where there is none', () => {
    const d = simulate(0.8, 1);
    expect(estimatePersonSd(d.people, d.predictions, d.labels)).toBeGreaterThan(0.55);
    expect(estimatePersonSd(d.people, d.predictions, d.labels)).toBeLessThan(1.05);
    const none = simulate(0, 2);
    expect(estimatePersonSd(none.people, none.predictions, none.labels)).toBeLessThan(0.2);
  });

  it('says nothing from fewer than 30 people', () => {
    expect(estimatePersonSd(['a', 'b'], [0.5, 0.5], [1, 0])).toBe(0);
  });

  it('moves a person’s effect by their record and narrows it as evidence grows (Laplace)', () => {
    const stage = { weights: [0], covariance: [0], personSd: 1, lambda: 1, converged: true };
    expect(personPosterior(stage, { residual: 0, information: 0 })).toEqual({ mean: 0, variance: 1 });
    // τ² = 1, r = −3, I = 10: mean −3/11, variance 1/11.
    const after = personPosterior(stage, { residual: -3, information: 10 });
    expect(after.mean).toBeCloseTo(-3 / 11, 12);
    expect(after.variance).toBeCloseTo(1 / 11, 12);
    expect(personPosterior({ ...stage, personSd: 0 }, { residual: -3, information: 10 })).toEqual({
      mean: 0,
      variance: 0,
    });
  });
});

describe('the exploration decision', () => {
  const model: RoutingModel = trainRoutingModel(
    simulateRouting({ questions: 400, world: 'availability', seed: 1 }).map((e, i) => ({
      ...e,
      profileId: `p${String(i % 300)}`,
    })),
  );
  /** A record of `routes` asks that went as predicted (residual 0): evidence, no surprise. */
  const asExpected = (routes: number): PersonHistory => ({
    availability: { residual: 0, information: 0.25 * routes },
    quality: { residual: 0, information: 0.1 * routes },
  });
  const person = (id: string, level: number, routes: number, explored = 0): ExploreCandidate => ({
    id,
    factors: FACTOR_ORDER.map(() => level),
    history: routes ? asExpected(routes) : NO_HISTORY,
    exploredThisWeek: explored,
  });

  it('replays exactly for the same decision, and records a propensity', () => {
    const greedy = person('g', 0.6, 40);
    const others = [person('n1', 0.55, 0), person('n2', 0.5, 0), person('w', 0.1, 50)];
    const a = decideLastPlace(model, greedy, others, 42);
    expect(decideLastPlace(model, greedy, others, 42)).toEqual(a);
    expect(a.propensity).toBeGreaterThan(0);
    expect(a.propensity).toBeLessThanOrEqual(1);
  });

  it('never explores someone known to be weak, and leaves the place to exploitation then', () => {
    const greedy = person('g', 0.7, 60);
    const weak = [person('w1', 0.05, 80), person('w2', 0.05, 80)];
    for (let seed = 1; seed <= 20; seed++) {
      const d = decideLastPlace(model, greedy, weak, seed);
      expect(d.id).toBe('g');
      expect(d.explored).toBe(false);
    }
  });

  it('explores uncertain people when justified, within the safety bound, and never past the weekly cap', () => {
    // People who differ beyond their factors (τ = 0.8): someone never asked is genuinely unknown.
    const uncertain: RoutingModel = {
      ...model,
      availability: { ...model.availability, personSd: 0.8 },
      quality: { ...model.quality, personSd: 0.8 },
    };
    const greedy = person('g', 0.5, 30);
    const fresh = [person('f1', 0.48, 0), person('f2', 0.47, 0), person('f3', 0.46, 0)];
    const decisions = Array.from({ length: 40 }, (_, s) => decideLastPlace(uncertain, greedy, fresh, s + 1));
    const explored = decisions.filter(d => d.explored);
    expect(explored.length).toBeGreaterThan(0);
    for (const d of explored) {
      expect(d.probabilityBetter).toBeGreaterThanOrEqual(MIN_PROBABILITY_BETTER);
      expect(d.mean).toBeGreaterThanOrEqual(0.5 * d.greedyMean);
    }
    const capped = fresh.map(f => ({ ...f, exploredThisWeek: WEEKLY_EXPLORE_CAP }));
    for (let s = 1; s <= 40; s++) expect(decideLastPlace(uncertain, greedy, capped, s).explored).toBe(false);
  });

  it('refuses to explore someone uncertain but clearly weaker: never at more than half a place’s value', () => {
    const uncertain: RoutingModel = {
      ...model,
      // Very wide person spread: the draws favour an unknown often enough to pass the uncertainty gate.
      availability: { ...model.availability, personSd: 6 },
      quality: { ...model.quality, personSd: 6 },
    };
    const greedy = person('g', 0.5, 30);
    const weakButUnknown = person('w', 0.25, 0);
    const reasons = new Set<string>();
    for (let s = 1; s <= 60; s++) {
      const d = decideLastPlace(uncertain, greedy, [weakButUnknown], s);
      reasons.add(d.reason);
      if (d.explored) expect(d.mean).toBeGreaterThanOrEqual(0.5 * d.greedyMean);
    }
    // The draw does favour them sometimes; the safety gate is what keeps them out.
    expect(reasons.has('too_costly')).toBe(true);
    expect(reasons.has('explored')).toBe(false);
  });

  it('logs a propensity that is exactly its share of a distribution summing to 1, gate fallbacks included', () => {
    const uncertain: RoutingModel = {
      ...model,
      availability: { ...model.availability, personSd: 0.8 },
      quality: { ...model.quality, personSd: 0.8 },
    };
    const greedy = person('g', 0.5, 30);
    // One fresh person at the cap: when they win the draw, the place falls back to 'g'.
    const others = [person('f1', 0.48, 0), person('capped', 0.49, 0, WEEKLY_EXPLORE_CAP)];
    for (let seed = 1; seed <= 20; seed++) {
      const d = decideLastPlace(uncertain, greedy, others, seed);
      const total = [...d.distribution.values()].reduce((s, p) => s + p, 0);
      expect(total).toBeCloseTo(1, 12);
      expect(d.propensity).toBe(d.distribution.get(d.id));
      expect(d.distribution.has('capped')).toBe(false);
    }
  });

  it('stops exploring someone whose record is poor, however few times they were asked', () => {
    const uncertain: RoutingModel = {
      ...model,
      availability: { ...model.availability, personSd: 0.8 },
      quality: { ...model.quality, personSd: 0.8 },
    };
    const greedy = person('g', 0.5, 30);
    // Asked 6 times, never answered, when the model expected them to answer most times.
    const poor: ExploreCandidate = {
      ...person('p', 0.48, 0),
      history: { availability: { residual: -4.5, information: 1.2 }, quality: { residual: 0, information: 0 } },
    };
    const fresh = person('f', 0.48, 0);
    let poorWins = 0;
    let freshWins = 0;
    for (let s = 1; s <= 60; s++) {
      if (decideLastPlace(uncertain, greedy, [poor], s).explored) poorWins++;
      if (decideLastPlace(uncertain, greedy, [fresh], s).explored) freshWins++;
    }
    expect(freshWins).toBeGreaterThan(0);
    expect(poorWins).toBeLessThan(freshWins / 3);
  });

  it('reads a record the way the model trained: residuals against its own predictions', () => {
    const f = FACTOR_ORDER.map(() => 0.5);
    const h = personHistory(model, [
      { factors: f, wave: 1, responded: true, helped: true, judged: true },
      { factors: f, wave: 1, responded: false, helped: false, judged: true },
      { factors: f, wave: 1, responded: true, helped: false, judged: false },
    ]);
    expect(h.availability.information).toBeGreaterThan(0);
    // Quality counts only the route answered on a judged question.
    const one = personHistory(model, [{ factors: f, wave: 1, responded: true, helped: true, judged: true }]);
    expect(h.quality).toEqual(one.quality);
  });

  it('estimates propensities that add up: across all outcomes of one decision, about 1', () => {
    const greedy = person('g', 0.5, 30);
    const others = [person('f1', 0.48, 0), person('f2', 0.47, 0)];
    // Over many seeds, how often each person gets the place should match their logged propensity.
    const seen = new Map<string, { n: number; p: number }>();
    for (let s = 1; s <= 200; s++) {
      const d = decideLastPlace(model, greedy, others, s);
      const e = seen.get(d.id) ?? { n: 0, p: 0 };
      e.n++;
      e.p += d.propensity;
      seen.set(d.id, e);
    }
    for (const { n, p } of seen.values()) expect(Math.abs(p / n - n / 200)).toBeLessThan(0.12);
  });
});

describe('watching a serving model', () => {
  const rows = (n: number, predicted: number, helpedEvery: number) =>
    Array.from({ length: n }, (_, i) => ({ predicted, helped: i % helpedEvery === 0 }));

  it('waits for 200 settled routes before judging', () => {
    expect(calibrationVerdict(rows(199, 0.3, 100))).toMatchObject({ demote: false, z: null, reason: /200 needed/ });
  });

  it('keeps a model whose predictions hold, and one short only by chance', () => {
    // Predicted 0.3, observed 1 in 3.
    expect(calibrationVerdict(rows(300, 0.3, 3)).demote).toBe(false);
    // Predicted 0.3, observed 0.27: short, but within chance.
    expect(calibrationVerdict(rows(300, 0.3, 4)).demote).toBe(false);
  });

  it('retires one that falls clearly and materially short', () => {
    // Predicted 0.3 (90 helpful expected of 300), observed 1 in 10 (30).
    const v = calibrationVerdict(rows(300, 0.3, 10));
    expect(v).toMatchObject({ demote: true, observed: 30 });
    expect(v.z).toBeLessThan(-2.576);
    expect(v.reason).toMatch(/retired, routing uses Ψ/);
  });
});

describe('what exploration costs', () => {
  it('estimates never exploring by self-normalized inverse propensity weighting', () => {
    const report = explorationReport([
      { reason: 'best_already', propensity: 0.5, helped: true },
      { reason: 'not_uncertain_enough', propensity: 0.25, helped: false },
      { reason: 'explored', propensity: 0.2, helped: true },
      { reason: 'explored', propensity: 0.1, helped: false },
    ]);
    // Kept places: weights 2 (helped) and 4 (not): (2·1 + 4·0) / (2 + 4) = 1/3.
    expect(report.neverExploreValue).toBeCloseTo(1 / 3, 12);
    expect(report.actualValue).toBe(0.5);
    expect(report).toMatchObject({
      decided: 4,
      explored: 2,
      exploredHelped: 0.5,
      keptHelped: 0.5,
      reasons: { best_already: 1, not_uncertain_enough: 1, explored: 2 },
    });
    expect(explorationReport([])).toMatchObject({ decided: 0, neverExploreValue: null, actualValue: null });
  });
});
