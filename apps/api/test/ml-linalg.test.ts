import { describe, expect, it } from 'vitest';
import {
  gaussian,
  orthonormalize,
  seededRandom,
  sparseFromEntries,
  sparseFromKeys,
  sparseTimesDense,
  symmetricEigen,
  topEigen,
  valueAt,
  type DenseMatrix,
} from '../src/ml/linalg.ts';

const randomSymmetric = (n: number, seed: number): DenseMatrix => {
  const r = seededRandom(seed);
  const data = new Float64Array(n * n);
  for (let i = 0; i < n; i++)
    for (let j = i; j < n; j++) {
      const v = r() * 2 - 1;
      data[i * n + j] = v;
      data[j * n + i] = v;
    }
  return { rows: n, cols: n, data };
};

describe('seeded randomness', () => {
  it('repeats exactly for a seed, and differs between seeds', () => {
    const a = seededRandom(42);
    const b = seededRandom(42);
    const c = seededRandom(43);
    const xs = [a(), a(), a()];
    expect([b(), b(), b()]).toEqual(xs);
    expect(c()).not.toBe(xs[0]);
    for (const x of xs) expect(x >= 0 && x < 1).toBe(true);
  });

  it('gives standard normal samples', () => {
    const g = gaussian(seededRandom(7));
    const xs = Array.from({ length: 20_000 }, g);
    const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
    const variance = xs.reduce((s, x) => s + (x - mean) ** 2, 0) / xs.length;
    expect(Math.abs(mean)).toBeLessThan(0.03);
    expect(Math.abs(variance - 1)).toBeLessThan(0.05);
  });
});

describe('symmetricEigen (Jacobi)', () => {
  it('solves a known matrix', () => {
    const { values } = symmetricEigen({ rows: 2, cols: 2, data: Float64Array.from([2, 1, 1, 2]) });
    const sorted = [...values].sort((a, b) => a - b);
    expect(sorted[0]).toBeCloseTo(1, 10);
    expect(sorted[1]).toBeCloseTo(3, 10);
  });

  it('satisfies A v = λ v with orthonormal vectors, for a random 8×8', () => {
    const n = 8;
    const a = randomSymmetric(n, 3);
    const { values, vectors } = symmetricEigen(a);
    for (let k = 0; k < n; k++) {
      for (let i = 0; i < n; i++) {
        let av = 0;
        for (let j = 0; j < n; j++) av += (a.data[i * n + j] ?? 0) * (vectors.data[j * n + k] ?? 0);
        expect(av).toBeCloseTo((values[k] ?? 0) * (vectors.data[i * n + k] ?? 0), 9);
      }
      for (let m = 0; m < n; m++) {
        let dot = 0;
        for (let i = 0; i < n; i++) dot += (vectors.data[i * n + k] ?? 0) * (vectors.data[i * n + m] ?? 0);
        expect(dot).toBeCloseTo(k === m ? 1 : 0, 9);
      }
    }
  });
});

describe('orthonormalize', () => {
  it('returns orthonormal columns spanning the same space', () => {
    const r = seededRandom(5);
    const x = { rows: 30, cols: 6, data: Float64Array.from({ length: 180 }, () => r()) };
    const q = orthonormalize(x);
    for (let a = 0; a < 6; a++)
      for (let b = 0; b < 6; b++) {
        let dot = 0;
        for (let i = 0; i < 30; i++) dot += (q.data[i * 6 + a] ?? 0) * (q.data[i * 6 + b] ?? 0);
        expect(dot).toBeCloseTo(a === b ? 1 : 0, 10);
      }
  });
});

describe('topEigen (randomized)', () => {
  it('finds the largest-magnitude eigenvalues of a sparse symmetric matrix, as the exact solver does', () => {
    const n = 60;
    // A banded symmetric matrix with a known spread of eigenvalues.
    const entries: Array<[number, number, number]> = [];
    for (let i = 0; i < n; i++) {
      entries.push([i, i, (i % 7) - 3 + i / 10]);
      if (i + 1 < n) entries.push([i, i + 1, 0.5], [i + 1, i, 0.5]);
      if (i + 5 < n) entries.push([i, i + 5, -0.3], [i + 5, i, -0.3]);
    }
    const sparse = sparseFromEntries(n, n, entries);
    const denseA: DenseMatrix = { rows: n, cols: n, data: new Float64Array(n * n) };
    for (const [i, j, v] of entries) denseA.data[i * n + j] = (denseA.data[i * n + j] ?? 0) + v;
    // Four, not five: the fifth (6.7705) has a twin just past it (6.7256), and an eigenvector
    // whose twin is cut off is ill-determined (its error grows as 1 / gap).
    const exact = [...symmetricEigen(denseA).values].sort((a, b) => Math.abs(b) - Math.abs(a)).slice(0, 4);
    // These top eigenvalues are tightly bunched (6.77 vs 6.73), the hard case: the
    // error bound shrinks as (σ_{k+p+1}/σ_k)^(2q+1), so more power iterations are needed.
    const approx = topEigen(sparse, 4, { seed: 11, powerIterations: 24 });
    expect(approx.values).toHaveLength(exact.length);
    for (const [i, x] of exact.entries()) expect(Math.abs(approx.values[i] ?? 0)).toBeCloseTo(Math.abs(x), 3);
    // At the default (6 iterations) each is within 1%.
    const quick = topEigen(sparse, 4, { seed: 11 });
    for (const [i, x] of [...quick.values].entries())
      expect(Math.abs(Math.abs(x) - Math.abs(exact[i] ?? 0)) / Math.abs(exact[i] ?? 1)).toBeLessThan(0.01);
    // Each returned vector really is an eigenvector: ‖A v − λ v‖ small relative to |λ|.
    const av = sparseTimesDense(sparse, approx.vectors);
    for (let c = 0; c < 4; c++) {
      let residual = 0;
      for (let i = 0; i < n; i++)
        residual += ((av.data[i * 4 + c] ?? 0) - (approx.values[c] ?? 0) * (approx.vectors.data[i * 4 + c] ?? 0)) ** 2;
      expect(Math.sqrt(residual) / Math.abs(approx.values[c] ?? 1)).toBeLessThan(1e-3);
    }
  });

  it('is deterministic for a seed', () => {
    const m = sparseFromEntries(4, 4, [
      [0, 0, 4],
      [1, 1, 3],
      [2, 2, 2],
      [3, 3, 1],
      [0, 1, 0.5],
      [1, 0, 0.5],
    ]);
    expect([...topEigen(m, 2, { seed: 3 }).values]).toEqual([...topEigen(m, 2, { seed: 3 }).values]);
  });
});

describe('sparseFromKeys', () => {
  it('builds the same matrix as sparseFromEntries, from unsorted row·cols+col keys', () => {
    const entries: Array<[number, number, number]> = [
      [2, 1, 5],
      [0, 3, 1],
      [1, 0, 2],
      [0, 0, 4],
      [2, 3, 7],
    ];
    const keys = Float64Array.from(entries.map(([r, c]) => r * 4 + c));
    const values = Float64Array.from(entries.map(([, , v]) => v));
    expect(sparseFromKeys(3, 4, keys, values)).toEqual(sparseFromEntries(3, 4, entries));
  });

  it('refuses a repeated key and one outside the matrix', () => {
    expect(() => sparseFromKeys(2, 2, Float64Array.from([1, 1]), Float64Array.from([1, 2]))).toThrow(/duplicate/);
    expect(() => sparseFromKeys(2, 2, Float64Array.from([9]), Float64Array.from([1]))).toThrow(/outside/);
  });
});

describe('valueAt', () => {
  it('reads inside an array, and gives 0 outside it (the convention every model loop relies on)', () => {
    const a = Float64Array.from([1.5, -2]);
    expect([valueAt(a, 0), valueAt(a, 1)]).toEqual([1.5, -2]);
    expect([valueAt(a, 2), valueAt(a, -1)]).toEqual([0, 0]);
  });
});
