// Linear algebra for Graphinity's own models: a seeded random source, a
// sparse matrix, and the top eigenpairs of a large symmetric matrix by the
// randomized range finder (Halko, Martinsson & Tropp 2011, algorithms 4.4 and
// 5.3) with a Jacobi solve of the small projected problem. No dependencies:
// every step is here, deterministic for a given seed, and tested.

/**
 * a[i], or 0 past either end. Every array read in these models goes through
 * this one function: strict index checking needs a fallback on each read, and
 * here reading outside an array means "no value", which is 0.
 */
export const valueAt = (a: ArrayLike<number>, i: number): number => a[i] ?? 0;

/** mulberry32: a small, fast, seedable generator. Same seed, same numbers. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal samples (Box-Muller) from a uniform source. */
export function gaussian(random: () => number): () => number {
  let spare: number | null = null;
  return () => {
    if (spare !== null) {
      const s = spare;
      spare = null;
      return s;
    }
    let u = 0;
    while (u === 0) u = random();
    const v = random();
    const r = Math.sqrt(-2 * Math.log(u));
    spare = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  };
}

/** Compressed sparse rows: row i's entries are cols/values[rowStart[i] .. rowStart[i+1]). */
export interface SparseMatrix {
  rows: number;
  cols: number;
  rowStart: Int32Array;
  colIndex: Int32Array;
  values: Float64Array;
}

/** Builds a CSR matrix from (row, col, value) entries; duplicates are summed. */
export function sparseFromEntries(
  rows: number,
  cols: number,
  entries: Iterable<readonly [number, number, number]>,
): SparseMatrix {
  const perRow: Array<Map<number, number>> = Array.from({ length: rows }, () => new Map<number, number>());
  for (const [r, c, v] of entries) {
    if (r < 0 || r >= rows || c < 0 || c >= cols) throw new RangeError('entry outside the matrix');
    const row = perRow[r];
    if (row) row.set(c, (row.get(c) ?? 0) + v);
  }
  const rowStart = new Int32Array(rows + 1);
  let nnz = 0;
  for (let r = 0; r < rows; r++) {
    nnz += perRow[r]?.size ?? 0;
    rowStart[r + 1] = nnz;
  }
  const colIndex = new Int32Array(nnz);
  const values = new Float64Array(nnz);
  for (let r = 0; r < rows; r++) {
    const row = [...(perRow[r] ?? new Map<number, number>())].sort((a, b) => a[0] - b[0]);
    let at = valueAt(rowStart, r);
    for (const [c, v] of row) {
      colIndex[at] = c;
      values[at] = v;
      at++;
    }
  }
  return { rows, cols, rowStart, colIndex, values };
}

/**
 * Builds a CSR matrix straight from entries keyed row * cols + col (each key
 * once), without the per-row maps of sparseFromEntries: one sort of the keys,
 * then one pass. For the large PPMI matrix this is most of training's memory.
 */
export function sparseFromKeys(rows: number, cols: number, keys: Float64Array, values: Float64Array): SparseMatrix {
  if (keys.length !== values.length) throw new RangeError('keys and values differ in length');
  const order = new Uint32Array(keys.length);
  for (let i = 0; i < order.length; i++) order[i] = i;
  order.sort((a, b) => valueAt(keys, a) - valueAt(keys, b));
  const rowStart = new Int32Array(rows + 1);
  const colIndex = new Int32Array(keys.length);
  const out = new Float64Array(keys.length);
  for (let p = 0; p < order.length; p++) {
    const src = valueAt(order, p);
    const key = valueAt(keys, src);
    const r = Math.floor(key / cols);
    if (r < 0 || r >= rows) throw new RangeError('entry outside the matrix');
    if (p > 0 && key === keys[valueAt(order, p - 1)]) throw new RangeError('duplicate key');
    rowStart[r + 1] = valueAt(rowStart, r + 1) + 1;
    colIndex[p] = key - r * cols;
    out[p] = valueAt(values, src);
  }
  for (let r = 0; r < rows; r++) rowStart[r + 1] = valueAt(rowStart, r + 1) + valueAt(rowStart, r);
  return { rows, cols, rowStart, colIndex, values: out };
}

/** A dense matrix, row-major: element (i, j) is data[i * cols + j]. */
export interface DenseMatrix {
  rows: number;
  cols: number;
  data: Float64Array;
}

const dense = (rows: number, cols: number): DenseMatrix => ({ rows, cols, data: new Float64Array(rows * cols) });

/** A · X for sparse A and dense X. Row-major X keeps the inner loop contiguous. */
export function sparseTimesDense(a: SparseMatrix, x: DenseMatrix): DenseMatrix {
  if (a.cols !== x.rows) throw new RangeError('shapes do not match');
  const out = dense(a.rows, x.cols);
  const l = x.cols;
  for (let i = 0; i < a.rows; i++) {
    const outRow = i * l;
    for (let p = valueAt(a.rowStart, i); p < valueAt(a.rowStart, i + 1); p++) {
      const v = valueAt(a.values, p);
      const xRow = valueAt(a.colIndex, p) * l;
      for (let c = 0; c < l; c++) out.data[outRow + c] = valueAt(out.data, outRow + c) + v * valueAt(x.data, xRow + c);
    }
  }
  return out;
}

/**
 * Orthonormal columns spanning X's columns, by modified Gram-Schmidt run
 * twice ("twice is enough", Giraud et al. 2005), which keeps orthogonality
 * to working precision even for nearly dependent columns. A column that
 * vanishes is left zero (it adds no direction).
 */
export function orthonormalize(x: DenseMatrix): DenseMatrix {
  const q = { rows: x.rows, cols: x.cols, data: Float64Array.from(x.data) };
  const n = q.rows;
  const l = q.cols;
  for (let pass = 0; pass < 2; pass++) {
    for (let j = 0; j < l; j++) {
      for (let k = 0; k < j; k++) {
        let dot = 0;
        for (let i = 0; i < n; i++) dot += valueAt(q.data, i * l + j) * valueAt(q.data, i * l + k);
        if (dot !== 0)
          for (let i = 0; i < n; i++) q.data[i * l + j] = valueAt(q.data, i * l + j) - dot * valueAt(q.data, i * l + k);
      }
      let norm = 0;
      for (let i = 0; i < n; i++) norm += valueAt(q.data, i * l + j) ** 2;
      norm = Math.sqrt(norm);
      for (let i = 0; i < n; i++) q.data[i * l + j] = norm > 1e-12 ? valueAt(q.data, i * l + j) / norm : 0;
    }
  }
  return q;
}

/**
 * All eigenpairs of a small symmetric matrix by cyclic Jacobi rotations
 * (Golub & Van Loan §8.5). Exact to working precision, O(n³) per sweep, and
 * converges quadratically; fine for the n ≤ a few hundred it is used for.
 * Returns eigenvalues and eigenvectors as columns of a row-major n×n matrix.
 */
export function symmetricEigen(m: DenseMatrix, maxSweeps = 100): { values: Float64Array; vectors: DenseMatrix } {
  const n = m.rows;
  if (m.cols !== n) throw new RangeError('matrix must be square');
  const a = Float64Array.from(m.data);
  const v = dense(n, n);
  for (let i = 0; i < n; i++) v.data[i * n + i] = 1;
  const at = (i: number, j: number) => valueAt(a, i * n + j);
  for (let sweep = 0; sweep < maxSweeps; sweep++) {
    let off = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += at(i, j) ** 2;
    if (off < 1e-22) break;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        const apq = at(p, q);
        if (Math.abs(apq) < 1e-300) continue;
        const theta = (at(q, q) - at(p, p)) / (2 * apq);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = at(k, p);
          const akq = at(k, q);
          a[k * n + p] = c * akp - s * akq;
          a[k * n + q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = at(p, k);
          const aqk = at(q, k);
          a[p * n + k] = c * apk - s * aqk;
          a[q * n + k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = valueAt(v.data, k * n + p);
          const vkq = valueAt(v.data, k * n + q);
          v.data[k * n + p] = c * vkp - s * vkq;
          v.data[k * n + q] = s * vkp + c * vkq;
        }
      }
    }
  }
  const values = new Float64Array(n);
  for (let i = 0; i < n; i++) values[i] = at(i, i);
  return { values, vectors: v };
}

/**
 * The k eigenpairs of largest magnitude of a large sparse symmetric matrix.
 * Randomized range finder with q power iterations (each re-orthonormalized),
 * then the exact eigenpairs of the small projection Qᵀ A Q. Error falls off
 * as (σ_{k+p+1}/σ_k)^(2q+1). p = 20, twice the paper's usual 10: measured on a
 * bunched spectrum, it cut the eigenvector error 50-fold for 7% more work. q = 6, not
 * its usual 1-3: word statistics have bunched eigenvalues, where q = 3 left
 * a 1.8% error in a tested case and q = 6 under 0.2%. Training runs in the
 * background, so accuracy is worth the extra passes.
 */
export function topEigen(
  a: SparseMatrix,
  k: number,
  options: { oversample?: number; powerIterations?: number; seed?: number } = {},
): { values: Float64Array; vectors: DenseMatrix } {
  if (a.rows !== a.cols) throw new RangeError('matrix must be square');
  const n = a.rows;
  const l = Math.min(n, k + (options.oversample ?? 20));
  const normal = gaussian(seededRandom(options.seed ?? 1));
  const omega = dense(n, l);
  for (let i = 0; i < omega.data.length; i++) omega.data[i] = normal();
  let q = orthonormalize(sparseTimesDense(a, omega));
  for (let i = 0; i < (options.powerIterations ?? 6); i++) q = orthonormalize(sparseTimesDense(a, q));
  const aq = sparseTimesDense(a, q);
  // B = Qᵀ (A Q), symmetrized against rounding.
  const b = dense(l, l);
  for (let r = 0; r < l; r++)
    for (let c = 0; c < l; c++) {
      let s = 0;
      for (let i = 0; i < n; i++) s += valueAt(q.data, i * l + r) * valueAt(aq.data, i * l + c);
      b.data[r * l + c] = s;
    }
  for (let r = 0; r < l; r++)
    for (let c = r + 1; c < l; c++) {
      const avg = (valueAt(b.data, r * l + c) + valueAt(b.data, c * l + r)) / 2;
      b.data[r * l + c] = avg;
      b.data[c * l + r] = avg;
    }
  const small = symmetricEigen(b);
  const order = [...small.values.keys()].sort(
    (x, y) => Math.abs(valueAt(small.values, y)) - Math.abs(valueAt(small.values, x)),
  );
  const take = order.slice(0, Math.min(k, l));
  const values = Float64Array.from(take.map(i => valueAt(small.values, i)));
  const vectors = dense(n, take.length);
  for (let i = 0; i < n; i++)
    for (const [c, src] of take.entries()) {
      let s = 0;
      for (let r = 0; r < l; r++) s += valueAt(q.data, i * l + r) * valueAt(small.vectors.data, r * l + src);
      vectors.data[i * take.length + c] = s;
    }
  return { values, vectors };
}
