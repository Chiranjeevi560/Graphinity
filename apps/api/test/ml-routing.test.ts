// Learned routing (ADR 0013): the model, its constraints, and the gate, on a
// simulated history with known truth (ml/routing-simulator.ts).
import { describe, expect, it } from 'vitest';
import { isHeldOut } from '../src/ml/embedding-gate.ts';
import { gaussian, seededRandom } from '../src/ml/linalg.ts';
import { predict } from '../src/ml/logistic.ts';
import { decideRouting, isRoutingHeldOut, MIN_ASKERS, strata, type GateExample } from '../src/ml/routing-gate.ts';
import {
  deserializeRoutingModel,
  fitConstrained,
  NON_NEGATIVE,
  scoreRouting,
  serializeRoutingModel,
  trainRoutingModel,
} from '../src/ml/routing-model.ts';
import { simulateRouting } from '../src/ml/routing-simulator.ts';
import { trainRoutingAndEvaluate } from '../src/ml/train-routing.ts';
import { FACTOR_ORDER, factorVector, psi, psiOfVector, type Candidate } from '../src/routing-score.ts';

const trustAt = FACTOR_ORDER.indexOf('trust');

describe('what routing records', () => {
  it('recomputes Ψ’s exploit score exactly from the stored vector', () => {
    const c: Candidate = {
      proximity: 0.7,
      skill: { mu: 30, sigma: 2 },
      expertiseWeight: 0.6,
      resident: true,
      pickedInCountry: false,
      trust: 0.4,
      helped: 3,
      answers: 5,
      picks: 2,
      medianReplySeconds: 3600,
      asked: 6,
      answered: 4,
      daysSinceActive: 2,
      routesInField: 9,
      usedToday: 0,
      circadianFit: 0.9,
      maxAffinityWithSelected: 0.25,
    };
    expect(psiOfVector(factorVector(c, 0.75))).toBeCloseTo(psi(c, { routes: 100, dailyLimit: 3 }), 12);
    expect(factorVector(c, 0.75)).toHaveLength(9);
    expect(factorVector(c, 0.75).every(x => x >= 0 && x <= 1)).toBe(true);
  });
});

describe('learning from outcomes', () => {
  it('beats Ψ where Ψ under-weighs availability, and is promoted', { timeout: 60_000 }, () => {
    const result = trainRoutingAndEvaluate({
      examples: simulateRouting({ questions: 1000, world: 'availability', seed: 1 }),
      serving: null,
      since: null,
    });
    expect(result.decision.promote).toBe(true);
    expect(result.decision.candidateAuc - result.decision.psiAuc).toBeGreaterThan(0.1);
    expect(result.artifact).not.toBeNull();
    expect(result.baseline.kind).toBe('psi');
  });

  it('is never promoted where Ψ is the truth', { timeout: 120_000 }, () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const result = trainRoutingAndEvaluate({
        examples: simulateRouting({ questions: 1000, world: 'psi', seed }),
        serving: null,
        since: null,
      });
      expect(result.decision.promote).toBe(false);
      expect(result.artifact).toBeNull();
    }
  });

  it('must also beat the model already serving', { timeout: 60_000 }, () => {
    const examples = simulateRouting({ questions: 1000, world: 'availability', seed: 2 });
    const first = trainRoutingAndEvaluate({ examples, serving: null, since: null });
    const again = trainRoutingAndEvaluate({
      examples,
      serving: { version: 3, artifact: first.artifact ?? new Uint8Array() },
      since: null,
    });
    expect(again.baseline).toMatchObject({ kind: 'model', version: 3 });
    expect(again.decision.servingAuc).toBeCloseTo(again.decision.candidateAuc, 12);
    // Equal is not worse: it may serve; strictly worse may not (decideRouting below).
    expect(again.decision.promote).toBe(true);
  });

  it(
    'never gives trust, reputation, proximity or country a negative weight, even when a ring asks for it',
    { timeout: 60_000 },
    () => {
      const honest = simulateRouting({ questions: 600, world: 'availability', seed: 3 });
      // Five accounts asking 400 questions and always "helping" the least trusted person asked.
      const ring: GateExample[] = [];
      for (let q = 0; q < 400; q++) {
        const rows = Array.from({ length: 5 }, (_, i) => {
          const factors = FACTOR_ORDER.map(() => 0.5);
          factors[trustAt] = i / 4;
          return factors;
        });
        rows.forEach((factors, i) =>
          ring.push({
            questionId: `ring${String(q)}`,
            askerId: `ring${String(q % 5)}`,
            wave: 1,
            factors,
            responded: true,
            helped: i === 0,
            judged: true,
            askerAgeDays: 30,
            askedAt: 0,
          }),
        );
      }
      const model = trainRoutingModel([...honest, ...ring]);
      for (const name of NON_NEGATIVE) {
        const k = FACTOR_ORDER.indexOf(name) + 1;
        expect(model.availability.weights[k]).toBeGreaterThanOrEqual(0);
        expect(model.quality.weights[k]).toBeGreaterThanOrEqual(0);
      }
      expect(model.quality.weights[trustAt + 1]).toBe(0);
    },
  );

  it('scores every route as if it came in wave 1, and keeps a factor that never varied at weight 0', () => {
    const examples = simulateRouting({ questions: 300, world: 'availability', seed: 4 }).map(e => ({
      ...e,
      factors: e.factors.map((x, k) => (k === trustAt ? 0 : x)),
    }));
    const model = trainRoutingModel(examples);
    expect(model.constant).toEqual(['trust']);
    expect(model.availability.weights[trustAt + 1]).toBe(0);
    const f = examples[0]?.factors ?? [];
    expect(scoreRouting(model, f)).toBeGreaterThan(0);
    expect(scoreRouting(model, f)).toBeLessThan(1);
  });
});

describe('constrained fitting', () => {
  it('pins a constrained weight at zero when the data want it negative, and leaves the rest free', () => {
    const x = Array.from({ length: 400 }, (_, i) => [((i * 7) % 20) / 10 - 1, ((i * 13) % 20) / 10 - 1]);
    const y = x.map(([a = 0, b = 0]) => (-2 * a + 1.5 * b > 0 ? 1 : 0));
    const free = fitConstrained(x, y, 1, []);
    const constrained = fitConstrained(x, y, 1, [0]);
    expect(free.weights[1]).toBeLessThan(0);
    expect(constrained.weights[1]).toBe(0);
    expect(constrained.weights[2]).toBeGreaterThan(0);
    expect(fitConstrained(x, y, 1, [], [1]).weights[2]).toBe(0);
  });

  it('ends at the constrained optimum: wherever a weight is held at 0, increasing it would not help', () => {
    let pinnedSeen = 0;
    for (let seed = 1; seed <= 100; seed++) {
      const random = seededRandom(seed);
      const normal = gaussian(random);
      const mix = [0, 1, 2].map(() => [normal(), normal(), normal()]);
      const truth = [normal(), 2 * normal(), 2 * normal(), 2 * normal()];
      const x = Array.from({ length: 200 }, () => {
        const z = [normal(), normal(), normal()];
        return mix.map(row => row.reduce((acc, m, j) => acc + m * (z[j] ?? 0), 0));
      });
      const y = x.map(row => (random() < predict({ weights: truth }, row) ? 1 : 0));
      const m = fitConstrained(x, y, 0.5, [0, 1, 2]);
      for (let k = 0; k < 3; k++) {
        expect(m.weights[k + 1]).toBeGreaterThanOrEqual(0);
        if (m.weights[k + 1] !== 0) continue;
        pinnedSeen++;
        let g = 0;
        x.forEach((row, i) => (g += ((y[i] ?? 0) - predict(m, row)) * (row[k] ?? 0)));
        expect(g).toBeLessThanOrEqual(1e-6);
      }
    }
    expect(pinnedSeen).toBeGreaterThan(50);
  });

  it('releases a pinned weight once others change and it would help, ending at the true optimum', () => {
    // Column 0 alone looks harmful (it's a stand-in for column 1); with column 1 pinned it helps.
    const x: number[][] = [];
    const y: number[] = [];
    for (let i = 0; i < 600; i++) {
      const a = ((i * 7) % 30) / 15 - 1;
      const b = ((i * 11) % 30) / 15 - 1;
      x.push([a - 0.9 * b, b]);
      y.push(a + 0.2 * b > 0 ? 1 : 0);
    }
    const free = fitConstrained(x, y, 0.5, []);
    const both = fitConstrained(x, y, 0.5, [0, 1]);
    expect(Math.min(free.weights[1] ?? 0, free.weights[2] ?? 0)).toBeGreaterThanOrEqual(0);
    // When nothing needs constraining, the constrained fit is the unconstrained one.
    expect(both.weights).toEqual(free.weights);
    expect(both.converged).toBe(true);
  });
});

describe('the gate', () => {
  const trained = { constant: [], trustLevels: 10 };
  const stratum = (askerId: string) => ({ askerId, factors: [[0.9], [0.1]], helped: [1, 0] });

  it('refuses while trust never varied, whatever the gain', () => {
    const all = Array.from({ length: 40 }, (_, i) => stratum(`a${String(i)}`));
    expect(
      decideRouting(
        all,
        all.map(() => 1),
        all.map(() => 0.5),
        null,
        { constant: ['trust'], trustLevels: 1 },
      ).reason,
    ).toMatch(/trust took 1 values/);
  });

  it('refuses while trust took fewer than 5 values: one moderator pick isn’t enough to learn from', () => {
    const all = Array.from({ length: 40 }, (_, i) => stratum(`a${String(i)}`));
    expect(
      decideRouting(
        all,
        all.map(() => 1),
        all.map(() => 0.5),
        null,
        { constant: [], trustLevels: 4 },
      ).reason,
    ).toMatch(/trust took 4 values/);
  });

  it('counts askers, not questions: one asker with many questions is one', () => {
    const all = [
      ...Array.from({ length: MIN_ASKERS - 1 }, (_, i) => stratum(`a${String(i)}`)),
      ...Array.from({ length: 500 }, () => stratum('prolific')),
    ];
    const d = decideRouting(
      all,
      all.map(() => 1),
      all.map(() => 0.5),
      null,
      trained,
    );
    // 529 strata, but the prolific asker's 500 count as one asker.
    expect(d).toMatchObject({ askers: MIN_ASKERS, strata: MIN_ASKERS - 1 + 500 });
    const fewer = decideRouting(
      all.slice(1),
      all.slice(1).map(() => 1),
      all.slice(1).map(() => 0.5),
      null,
      trained,
    );
    expect(fewer.reason).toMatch(/29 different askers/);
  });

  it('needs a real gain beyond noise, and refuses to replace a better serving model', () => {
    const all = Array.from({ length: 40 }, (_, i) => stratum(`a${String(i)}`));
    const small = all.map((_, i) => 0.5 + (i % 2 ? 0.03 : -0.01));
    expect(
      decideRouting(
        all,
        small,
        all.map(() => 0.5),
        null,
        trained,
      ).reason,
    ).toMatch(/not better than Ψ by enough/);
    const gain = all.map(() => 0.8);
    expect(
      decideRouting(
        all,
        gain,
        all.map(() => 0.5),
        null,
        trained,
      ).promote,
    ).toBe(true);
    expect(
      decideRouting(
        all,
        gain,
        all.map(() => 0.5),
        all.map(() => 0.9),
        trained,
      ).reason,
    ).toMatch(/worse than the serving/);
  });

  it('judges only held-out questions with both outcomes, from askers 14 days old, asked since the last rejection', () => {
    const row = (q: string, helped: boolean, extra: Partial<GateExample> = {}): GateExample => ({
      questionId: q,
      askerId: 'a',
      wave: 1,
      factors: FACTOR_ORDER.map(() => 0.5),
      responded: true,
      helped,
      judged: true,
      askerAgeDays: 30,
      askedAt: 1000,
      ...extra,
    });
    expect(strata([row('1', true), row('1', false)], null)).toHaveLength(1);
    expect(strata([row('1', true), row('1', true)], null)).toHaveLength(0);
    expect(strata([row('1', true, { askerAgeDays: 3 }), row('1', false, { askerAgeDays: 3 })], null)).toHaveLength(0);
    expect(strata([row('1', true), row('1', false)], 1000)).toHaveLength(0);
    // Different waves of one question are judged apart.
    expect(
      strata([row('1', true), row('1', false), row('1', true, { wave: 2 }), row('1', false, { wave: 2 })], null),
    ).toHaveLength(2);
  });

  it('holds out a different fifth of questions from the text model', () => {
    const ids = Array.from({ length: 2000 }, (_, i) => String(i + 1));
    const held = ids.filter(isRoutingHeldOut).length;
    // Independent fifths overlap in about 1 question in 25, not 1 in 5.
    const both = ids.filter(id => isRoutingHeldOut(id) && isHeldOut(id)).length;
    expect(both / ids.length).toBeLessThan(0.08);
    expect(held / ids.length).toBeGreaterThan(0.17);
    expect(held / ids.length).toBeLessThan(0.23);
  });
});

describe('scoring', () => {
  it('is P(answers) × P(helps | answers) with the wave terms left out', () => {
    const model = trainRoutingModel(simulateRouting({ questions: 200, world: 'availability', seed: 6 }));
    const f = FACTOR_ORDER.map((_, k) => (k % 3) / 3);
    const x = [
      ...f.map((v, k) => ((model.sd[k] ?? 0) > 1e-9 ? (v - (model.mean[k] ?? 0)) / (model.sd[k] ?? 1) : 0)),
      0,
      0,
    ];
    expect(scoreRouting(model, f)).toBeCloseTo(predict(model.availability, x) * predict(model.quality, x), 12);
  });

  it('learns quality only where the asker judged something', { timeout: 60_000 }, () => {
    const judged = simulateRouting({ questions: 400, world: 'availability', seed: 7 });
    // Many unjudged questions where the most proximate people "didn't help" (nobody looked).
    const unjudged = Array.from({ length: 3000 }, (_, i) => ({
      ...(judged[i % judged.length] as GateExample),
      questionId: `u${String(i)}`,
      factors: FACTOR_ORDER.map((name, k) => (name === 'proximity' ? 1 : (judged[i % judged.length]?.factors[k] ?? 0))),
      responded: true,
      helped: false,
      judged: false,
    }));
    const proximity = FACTOR_ORDER.indexOf('proximity') + 1;
    const clean = trainRoutingModel(judged).quality.weights[proximity] ?? 0;
    const mixed = trainRoutingModel([...judged, ...unjudged]).quality.weights[proximity] ?? 0;
    expect(clean).toBeGreaterThan(0.1);
    // Only the standardization moves; the unjudged outcomes themselves are never fitted.
    expect(mixed).toBeGreaterThan(0.05);
  });
});

describe('the stored model', () => {
  it('round-trips, and refuses anything for other factors or with broken numbers', () => {
    const model = trainRoutingModel(simulateRouting({ questions: 200, world: 'availability', seed: 5 }));
    const back = deserializeRoutingModel(serializeRoutingModel(model));
    expect(back).toEqual(model);
    const tamper = (change: (m: Record<string, unknown>) => void) => {
      const m = JSON.parse(serializeRoutingModel(model).toString()) as Record<string, unknown>;
      change(m);
      return () => deserializeRoutingModel(Buffer.from(JSON.stringify(m)));
    };
    expect(tamper(m => (m.factorsVersion = 2))).toThrow(/not a Graphinity routing model/);
    expect(tamper(m => (m.mean = [null]))).toThrow(/not a Graphinity routing model/);
    expect(tamper(m => ((m.quality as { weights: unknown[] }).weights = [1, 2]))).toThrow(/not a Graphinity/);
    expect(tamper(m => (m.v = 2))).toThrow(/not a Graphinity/);
  });
});
