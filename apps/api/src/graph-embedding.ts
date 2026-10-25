// Node embeddings for personal graphs (ADR 0012): NetMF (Qiu, Dong, Ma, Li,
// Wang & Tang 2018), which shows DeepWalk's skip-gram training converges to
// factorizing log(max(M, 1)) with
//
//   M = vol(G) / (b·T) · (Σ_{r=1..T} (D⁻¹A)^r) · D⁻¹
//
// so the matrix is computed exactly (no sampled walks, no learning rate) and
// factorized with the same randomized eigensolver as the text model
// (ml/linalg.ts), with b = 1 negative sample. Window T = 2, measured: hidden
// links found as well as T = 5 or 10 (within 0.005 AUC on every planted
// graph tried) at 40% of the cost; T = 1 lost 0.05-0.1 AUC on harder graphs.
// The log matters too: without it, AUC fell from 0.68 to 0.60 at 50% mixing.
// For an undirected graph M is symmetric, so its eigenvectors are its
// singular vectors and the embedding is U·√|λ|, rows L2-normalized.
//
// Cost for n nodes and z stored edge entries: T sparse-times-dense products,
// O(T·z·n) time and O(n²) memory (8 MB at the personal graph's 1,000-node cap),
// then O(z'·k·q) for the eigensolver on the z' entries where M > 1.
import {
  sparseFromEntries,
  sparseFromKeys,
  sparseTimesDense,
  topEigen,
  valueAt,
  type DenseMatrix,
} from './ml/linalg.ts';
import type { Adjacency } from './graph-communities.ts';

export const NETMF_WINDOW = 2;
export const NETMF_DIMENSIONS = 16;

/** One unit vector per node (all zeros for a node with no edges). */
export function netmfEmbedding(
  adjacency: Adjacency,
  options: { window?: number; dimensions?: number; seed?: number; powerIterations?: number } = {},
): Float64Array[] {
  const n = adjacency.length;
  const window = options.window ?? NETMF_WINDOW;
  const dims = Math.min(options.dimensions ?? NETMF_DIMENSIONS, n);
  const degree = Float64Array.from(adjacency, row => row.reduce((s, [, w]) => s + w, 0));
  const volume = degree.reduce((s, d) => s + d, 0);
  const empty = () => Array.from({ length: n }, () => new Float64Array(dims));
  if (n === 0 || volume === 0) return empty();

  // P = D⁻¹A, the random walk's one-step transition matrix.
  const p = sparseFromEntries(
    n,
    n,
    adjacency.flatMap((row, i) => row.map(([j, w]) => [i, j, w / valueAt(degree, i)] as const)),
  );
  // S = Σ_{r=1..T} P^r: power holds P^r, starting from the identity.
  let power: DenseMatrix = { rows: n, cols: n, data: new Float64Array(n * n) };
  for (let i = 0; i < n; i++) power.data[i * n + i] = 1;
  const sum = new Float64Array(n * n);
  for (let r = 0; r < window; r++) {
    power = sparseTimesDense(p, power);
    for (let x = 0; x < sum.length; x++) sum[x] = valueAt(sum, x) + valueAt(power.data, x);
  }
  const scale = volume / window;
  // log(max(M, 1)) keeps only entries above 1: count them, then fill typed arrays
  // (one tuple per entry was most of the garbage at the node cap).
  const m = (i: number, j: number) => {
    const di = valueAt(degree, i);
    const dj = valueAt(degree, j);
    if (di === 0 || dj === 0) return 0;
    // Symmetrized against rounding: M_ij and M_ji are equal in exact arithmetic.
    return (scale * (valueAt(sum, i * n + j) / dj + valueAt(sum, j * n + i) / di)) / 2;
  };
  let count = 0;
  for (let i = 0; i < n; i++) for (let j = i; j < n; j++) if (m(i, j) > 1) count += i === j ? 1 : 2;
  if (count === 0 || dims === 0) return empty();
  const keys = new Float64Array(count);
  const logs = new Float64Array(count);
  let at = 0;
  for (let i = 0; i < n; i++)
    for (let j = i; j < n; j++) {
      const v = m(i, j);
      if (v <= 1) continue;
      const log = Math.log(v);
      keys[at] = i * n + j;
      logs[at++] = log;
      if (i !== j) {
        keys[at] = j * n + i;
        logs[at++] = log;
      }
    }
  const { values, vectors } = topEigen(sparseFromKeys(n, n, keys, logs), dims, {
    seed: options.seed ?? 1,
    powerIterations: options.powerIterations ?? 6,
  });
  const k = values.length;
  return Array.from({ length: n }, (_, i) => {
    const v = new Float64Array(dims);
    if (valueAt(degree, i) === 0) return v;
    let norm = 0;
    for (let c = 0; c < k; c++) {
      const x = valueAt(vectors.data, i * k + c) * Math.sqrt(Math.abs(valueAt(values, c)));
      v[c] = x;
      norm += x * x;
    }
    norm = Math.sqrt(norm);
    if (norm > 0) for (let c = 0; c < k; c++) v[c] = valueAt(v, c) / norm;
    return v;
  });
}

export function cosineOf(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += valueAt(a, i) * valueAt(b, i);
  return s;
}
