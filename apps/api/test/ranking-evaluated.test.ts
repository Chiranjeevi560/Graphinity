// The algorithms the charter asked to be evaluated (ADR 0032). Each test states the property that makes it correct, on
// data where the wrong version would visibly fail.
import { describe, expect, it } from 'vitest';
import { dppGreedy, mmr, type Candidate } from '../src/ml/diversity.ts';
import { doubleMl } from '../src/ml/double-ml.ts';
import { seededRandom } from '../src/ml/linalg.ts';
import { predictMmoe, trainMmoe, utility } from '../src/ml/mmoe.ts';
import { encodePq, encodeSq8, pqTable, scorePq, scoreSq8, trainPq, trainSq8 } from '../src/ml/quantize.ts';
import { topItems, trainTwoTower } from '../src/ml/two-tower.ts';

// Two near-copies of the best result, and one different result a little behind.
const copies: Candidate[] = [
  { relevance: 1, vector: [1, 0] },
  { relevance: 0.99, vector: [1, 0] },
  { relevance: 0.8, vector: [0, 1] },
];

describe('diversity', () => {
  it('MMR is plain relevance at lambda 1, and prefers the different result below that', () => {
    expect(mmr(copies, 3, 1)).toEqual([0, 1, 2]);
    expect(mmr(copies, 2, 0.5)).toEqual([0, 2]);
  });

  it('DPP never picks an exact copy over something new, and stops rather than repeat', () => {
    expect(dppGreedy(copies, 2, 1)).toEqual([0, 2]);
    expect(dppGreedy(copies, 3, 1).slice(0, 2)).toEqual([0, 2]);
  });

  it('both return each result at most once, and at most k', () => {
    const random = seededRandom(3);
    const many: Candidate[] = Array.from({ length: 40 }, () => {
      const a = random() * 6.28;
      return { relevance: random(), vector: [Math.cos(a), Math.sin(a)] };
    });
    for (const picked of [mmr(many, 10, 0.7), dppGreedy(many, 10, 1)]) {
      expect(picked.length).toBeLessThanOrEqual(10);
      expect(new Set(picked).size).toBe(picked.length);
    }
    expect(mmr([], 5, 0.5)).toEqual([]);
    expect(dppGreedy([], 5, 1)).toEqual([]);
  });
});

describe('quantization', () => {
  const random = seededRandom(5);
  const vectors = Array.from({ length: 600 }, () => {
    const v = Float32Array.from({ length: 16 }, () => random() - 0.5);
    const norm = Math.hypot(...v);
    return v.map(x => x / norm);
  });
  const exact = (q: Float32Array, v: Float32Array) => q.reduce((sum, x, i) => sum + x * (v[i] ?? 0), 0);

  it('SQ8 stays within half a step per dimension', () => {
    const m = trainSq8(vectors);
    const q = vectors[0] ?? new Float32Array(16);
    const v = vectors[1] ?? new Float32Array(16);
    const worst = q.reduce((sum, x, i) => sum + (Math.abs(x) * (m.step[i] ?? 0)) / 2, 0);
    expect(Math.abs(scoreSq8(m, q, encodeSq8(m, v)) - exact(q, v))).toBeLessThanOrEqual(worst + 1e-5);
  });

  it('PQ finds a vector when asked for itself, far more often than chance', () => {
    const m = trainPq(vectors, 4, 6);
    expect(() => trainPq(vectors, 5)).toThrow();
    const codes = vectors.map(v => encodePq(m, v));
    let hits = 0;
    for (let i = 0; i < 50; i++) {
      const q = vectors[i] ?? new Float32Array(16);
      const table = pqTable(m, q);
      const top = codes
        .map((c, j) => [scorePq(m, table, c), j] as const)
        .sort((a, b) => b[0] - a[0])
        .slice(0, 10)
        .map(x => x[1]);
      if (top.includes(i)) hits++;
    }
    expect(hits).toBeGreaterThan(35);
  });
});

describe('two towers', () => {
  // Two groups of people, each liking its own half of the items.
  const random = seededRandom(7);
  const pairs = Array.from({ length: 6000 }, () => {
    const user = Math.floor(random() * 40);
    const item = (user % 2) * 20 + Math.floor(random() * 20);
    return [user, item] as const;
  });

  it('learns who likes what, with and without the correction', () => {
    for (const logQ of [false, true]) {
      const model = trainTwoTower(pairs, { users: 40, items: 40, dims: 8, epochs: 4, logQ });
      const top = topItems(model, 1, 10);
      expect(top.filter(i => i >= 20).length, String(logQ)).toBeGreaterThanOrEqual(9);
    }
  });

  it('leaves out what it is told to skip', () => {
    const model = trainTwoTower(pairs.slice(0, 500), { users: 40, items: 40, dims: 4, epochs: 1 });
    const skip = new Set(topItems(model, 0, 3));
    expect(topItems(model, 0, 3, skip).some(i => skip.has(i))).toBe(false);
  });
});

describe('multi-task', () => {
  it('learns two opposed tasks, which a single shared gate still separates through its towers', () => {
    const random = seededRandom(9);
    const rows = Array.from({ length: 1500 }, () => {
      const x = [random() * 2 - 1, random() * 2 - 1];
      return { x, y: [(x[0] ?? 0) > 0 ? 1 : 0, (x[0] ?? 0) < 0 ? 1 : 0] };
    });
    const m = trainMmoe(rows, { inputs: 2, tasks: 2, epochs: 15 });
    expect(predictMmoe(m, [0.9, 0], 0)).toBeGreaterThan(0.7);
    expect(predictMmoe(m, [0.9, 0], 1)).toBeLessThan(0.3);
    expect(predictMmoe(m, [-0.9, 0], 1)).toBeGreaterThan(0.7);
  });

  it('skips a task a row says nothing about', () => {
    const rows = Array.from({ length: 200 }, () => ({ x: [1], y: [1, null] }));
    const m = trainMmoe(rows, { inputs: 1, tasks: 2, epochs: 3, seed: 2 });
    expect(m.towerBias[1]).toBe(0);
    expect(m.towerBias[0]).toBeGreaterThan(0);
  });

  it('blends by the weights given', () => {
    expect(utility([0.5, 0.5], [2, -1])).toBeCloseTo(0.5);
  });
});

describe('double machine learning', () => {
  // Who gets treated depends on x, and x drives the outcome: comparing averages overstates the effect.
  const random = seededRandom(11);
  const rows = Array.from({ length: 4000 }, () => {
    const x = [random() * 2 - 1];
    const treatment = random() < 0.5 + 0.4 * (x[0] ?? 0) ? 1 : 0;
    return { x, treatment, y: 3 * (x[0] ?? 0) + 1 * treatment + (random() - 0.5) };
  });

  it('finds the true effect where comparing averages does not', () => {
    const mean = (r: typeof rows) => r.reduce((s, a) => s + a.y, 0) / r.length;
    const naive = mean(rows.filter(r => r.treatment)) - mean(rows.filter(r => !r.treatment));
    expect(naive).toBeGreaterThan(1.5);
    expect(doubleMl(rows)?.effect).toBeCloseTo(1, 1);
  });

  it('gives an interval that holds the true effect about as often as it claims', () => {
    const fresh = seededRandom(13);
    const trials = 60;
    let held = 0;
    for (let t = 0; t < trials; t++) {
      const data = Array.from({ length: 800 }, () => {
        const x = [fresh() * 2 - 1];
        const treatment = fresh() < 0.5 + 0.4 * (x[0] ?? 0) ? 1 : 0;
        return { x, treatment, y: 3 * (x[0] ?? 0) + treatment + (fresh() - 0.5) };
      });
      const r = doubleMl(data, { seed: t + 1 });
      if (r && r.low <= 1 && r.high >= 1) held++;
    }
    expect(held / trials).toBeGreaterThan(0.85);
  });

  it('declines when there is nothing to learn from', () => {
    expect(doubleMl(rows.slice(0, 3))).toBeNull();
    expect(doubleMl(rows.slice(0, 200).map(r => ({ ...r, treatment: 1 })))).toBeNull();
  });
});
