// Contextual bandits for exploring new items (Li et al., WWW 2010). Each action
// keeps A⁻¹ directly: Sherman-Morrison updates it in O(d²), where re-solving
// would be O(d³). Thompson sampling is the randomized alternative
// (Agrawal & Goyal 2013); both are compared on regret in benchmark-platform.mjs.
import { at } from './num.ts';

export interface LinArm {
  /** A⁻¹, row by row. */
  inverse: Float64Array;
  b: Float64Array;
  d: number;
}

export function newArm(d: number, ridge = 1): LinArm {
  const inverse = new Float64Array(d * d);
  for (let i = 0; i < d; i++) inverse[i * d + i] = 1 / ridge;
  return { inverse, b: new Float64Array(d), d };
}

function times(arm: LinArm, x: ArrayLike<number>, out: Float64Array): void {
  for (let i = 0; i < arm.d; i++) {
    let s = 0;
    for (let j = 0; j < arm.d; j++) s += at(arm.inverse, i * arm.d + j) * at(x, j);
    out[i] = s;
  }
}

function dot(a: ArrayLike<number>, b: ArrayLike<number>, d: number): number {
  let s = 0;
  for (let i = 0; i < d; i++) s += at(a, i) * at(b, i);
  return s;
}

/** A ← A + xxᵀ, b ← b + r x. */
export function update(arm: LinArm, x: ArrayLike<number>, reward: number): void {
  const { d } = arm;
  const ax = new Float64Array(d);
  times(arm, x, ax);
  const denominator = 1 + dot(x, ax, d);
  for (let i = 0; i < d; i++)
    for (let j = 0; j < d; j++)
      arm.inverse[i * d + j] = at(arm.inverse, i * d + j) - (at(ax, i) * at(ax, j)) / denominator;
  for (let i = 0; i < d; i++) arm.b[i] = at(arm.b, i) + reward * at(x, i);
}

/** θ̂ᵀx + α√(xᵀA⁻¹x). */
export function ucb(arm: LinArm, x: ArrayLike<number>, alpha: number): number {
  const ax = new Float64Array(arm.d);
  times(arm, x, ax);
  // θ̂ᵀx = bᵀA⁻¹x, since A⁻¹ is symmetric.
  return dot(arm.b, ax, arm.d) + alpha * Math.sqrt(Math.max(0, dot(x, ax, arm.d)));
}

/** A Thompson draw of the reward: mean plus noise scaled by this context's uncertainty. */
export function thompson(arm: LinArm, x: ArrayLike<number>, scale: number, normal: () => number): number {
  const ax = new Float64Array(arm.d);
  times(arm, x, ax);
  return dot(arm.b, ax, arm.d) + scale * Math.sqrt(Math.max(0, dot(x, ax, arm.d))) * normal();
}

/** The Box-Muller transform over any uniform source. */
export function normalFrom(uniform: () => number): () => number {
  return () => Math.sqrt(-2 * Math.log(Math.max(1e-300, uniform()))) * Math.cos(2 * Math.PI * uniform());
}
