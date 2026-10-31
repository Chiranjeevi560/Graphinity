// Ridge regression by the normal equations and Cholesky: the small, exact model
// behind uplift, elasticity and student classifiers. O(n d² + d³) with few features.
import { at } from './num.ts';

export interface RidgeModel {
  w: Float64Array;
  intercept: number;
}

export function fitRidge(rows: ReadonlyArray<{ x: readonly number[]; y: number }>, l2 = 1): RidgeModel {
  const d = rows[0]?.x.length ?? 0;
  const n = rows.length;
  if (n === 0) return { w: new Float64Array(d), intercept: 0 };
  const mx = new Float64Array(d);
  let my = 0;
  for (const r of rows) {
    my += r.y;
    for (let j = 0; j < d; j++) mx[j] = at(mx, j) + at(r.x, j);
  }
  my /= n;
  for (let j = 0; j < d; j++) mx[j] = at(mx, j) / n;
  const a = new Float64Array(d * d);
  const b = new Float64Array(d);
  for (const r of rows) {
    const dy = r.y - my;
    for (let i = 0; i < d; i++) {
      const xi = at(r.x, i) - at(mx, i);
      b[i] = at(b, i) + xi * dy;
      for (let j = 0; j <= i; j++) a[i * d + j] = at(a, i * d + j) + xi * (at(r.x, j) - at(mx, j));
    }
  }
  for (let i = 0; i < d; i++) a[i * d + i] = at(a, i * d + i) + l2;
  // Cholesky: A = LLᵀ, in place in the lower triangle.
  for (let i = 0; i < d; i++)
    for (let j = 0; j <= i; j++) {
      let s = at(a, i * d + j);
      for (let k = 0; k < j; k++) s -= at(a, i * d + k) * at(a, j * d + k);
      a[i * d + j] = i === j ? Math.sqrt(Math.max(1e-12, s)) : s / (a[j * d + j] ?? 1);
    }
  const w = new Float64Array(d);
  for (let i = 0; i < d; i++) {
    let s = at(b, i);
    for (let k = 0; k < i; k++) s -= at(a, i * d + k) * at(w, k);
    w[i] = s / (a[i * d + i] ?? 1);
  }
  for (let i = d - 1; i >= 0; i--) {
    let s = at(w, i);
    for (let k = i + 1; k < d; k++) s -= at(a, k * d + i) * at(w, k);
    w[i] = s / (a[i * d + i] ?? 1);
  }
  let intercept = my;
  for (let j = 0; j < d; j++) intercept -= at(w, j) * at(mx, j);
  return { w, intercept };
}

export function predictRidge(m: RidgeModel, x: readonly number[]): number {
  let s = m.intercept;
  for (let j = 0; j < m.w.length; j++) s += at(m.w, j) * at(x, j);
  return s;
}
