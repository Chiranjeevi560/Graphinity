// Feature drift (docs/adr/0018-drift-monitoring.md): has what a serving
// model sees moved away from what it was trained on?
//
// At training, each input feature is summarized as a profile: PROFILE_POINTS
// evenly spaced quantiles plus count, mean and standard deviation (a few KB
// per model, no raw values kept). In service, a recent sample of the same
// feature is compared with the profile two ways:
// - PSI (population stability index) over the reference's deciles: how much
//   the shares moved, a size of effect that doesn't grow with sample size;
// - the two-sample Kolmogorov-Smirnov test against the profile's CDF: whether
//   the move is more than chance at this sample size.
// A feature drifts only when both say so: PSI >= 0.05 and KS significant
// (scripts/benchmark-drift.mjs). KS alone flags every negligible move once
// samples are large; PSI alone at the usual 0.1-0.25 bars misses material
// moves of flags (30% to 45% is PSI 0.097). Every function is pure and
// deterministic.

export const PROFILE_POINTS = 201;
/** PSI's shares are floored here, so an empty bin can't make it infinite. */
const FLOOR = 1e-4;

export interface Profile {
  /** PROFILE_POINTS quantiles, from the minimum (0) to the maximum (1). */
  quantiles: number[];
  n: number;
  mean: number;
  sd: number;
}

export interface DriftRule {
  /** PSI at or above which the move is large enough to matter. */
  psi: number;
  /** Significance for KS, before dividing by the number of features tested. */
  alpha: number;
  /** Fewer current values than this: no verdict. */
  minCurrent: number;
}

export const DRIFT_RULE: DriftRule = { psi: 0.05, alpha: 0.01, minCurrent: 200 };

export interface FeatureDrift {
  feature: string;
  psi: number;
  ks: number;
  p: number;
  n: number;
  drifted: boolean;
}

/**
 * Quantile q of sorted values as the inverse empirical CDF (type 1): always
 * a value that occurred. Interpolating (type 7) would invent values between
 * a flag's 0 and 1 and blur its point masses.
 */
function quantileOf(sorted: Float64Array, q: number): number {
  const i = Math.max(0, Math.ceil(q * sorted.length) - 1);
  return sorted[Math.min(i, sorted.length - 1)] ?? 0;
}

const sortedOf = (values: ArrayLike<number>) => Float64Array.from(values).sort();

/** The profile of a feature's reference values. Null for no values. O(n log n). */
export function profileOf(values: ArrayLike<number>): Profile | null {
  if (values.length === 0) return null;
  const sorted = sortedOf(values);
  let sum = 0;
  for (const v of sorted) sum += v;
  const mean = sum / sorted.length;
  let ss = 0;
  for (const v of sorted) ss += (v - mean) ** 2;
  return {
    quantiles: Array.from({ length: PROFILE_POINTS }, (_, i) => quantileOf(sorted, i / (PROFILE_POINTS - 1))),
    n: sorted.length,
    mean,
    sd: Math.sqrt(ss / sorted.length),
  };
}

/** Number of elements of sorted `a` that are < x (strict) or <= x. Binary search, O(log n). */
function rank(a: ArrayLike<number>, x: number, inclusive: boolean): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const v = a[mid] ?? 0;
    if (inclusive ? v <= x : v < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * The reference CDF from its quantiles, at x (inclusive: P(X <= x); else
 * P(X < x)). Between distinct quantiles it interpolates linearly; at runs of
 * equal quantiles (a discrete value) it steps, so flags and counts keep their
 * point masses.
 */
function referenceCdf(q: readonly number[], x: number, inclusive: boolean): number {
  const k = q.length - 1;
  const first = q[0] ?? 0;
  const last = q[k] ?? 0;
  if (x < first || (!inclusive && x === first)) return 0;
  if (x > last || (inclusive && x === last)) return 1;
  const below = rank(q, x, false);
  const upTo = rank(q, x, true);
  if (upTo > below) {
    // x is a quantile value, possibly repeated at indices below..upTo-1: the
    // CDF reaches below/k just before x and (upTo-1)/k at x.
    return (inclusive ? upTo - 1 : below) / k;
  }
  // Strictly between q[below - 1] and q[below].
  const a = q[below - 1] ?? first;
  const b = q[below] ?? last;
  return (below - 1 + (b > a ? (x - a) / (b - a) : 0)) / k;
}

/**
 * PSI over the reference's deciles (equal-share bins; ties merged), plus a
 * bin each for values below the reference's minimum and above its maximum,
 * where the reference has no share: without them a feature that was constant
 * in training (every word known) couldn't show anything moving below it.
 * O(m log m).
 */
export function psi(reference: Profile, current: ArrayLike<number>): number {
  if (current.length === 0) return 0;
  const q = reference.quantiles;
  const k = q.length - 1;
  const min = q[0] ?? 0;
  const max = q[k] ?? 0;
  const edges = [...new Set([1, 2, 3, 4, 5, 6, 7, 8, 9].map(d => q[Math.round((d * k) / 10)] ?? 0))].sort(
    (a, b) => a - b,
  );
  // Bins: below min, [min, e0], (e0, e1], ..., (e_last, max], above max.
  const expected: number[] = [0];
  let previous = 0;
  for (const e of edges) {
    const upTo = referenceCdf(q, e, true);
    expected.push(upTo - previous);
    previous = upTo;
  }
  expected.push(1 - previous, 0);
  const counts = new Array<number>(edges.length + 3).fill(0);
  for (let i = 0; i < current.length; i++) {
    const v = current[i] ?? 0;
    const bin = v < min ? 0 : v > max ? edges.length + 2 : 1 + rank(edges, v, false);
    counts[bin] = (counts[bin] ?? 0) + 1;
  }
  let total = 0;
  for (let i = 0; i < counts.length; i++) {
    const a = Math.max(FLOOR, (counts[i] ?? 0) / current.length);
    const e = Math.max(FLOOR, expected[i] ?? 0);
    total += (a - e) * Math.log(a / e);
  }
  return total;
}

/** P(K > λ) for the Kolmogorov distribution. */
function kolmogorovTail(lambda: number): number {
  if (lambda < 0.27) return 1;
  let sum = 0;
  for (let j = 1; j <= 100; j++) {
    const term = 2 * (j % 2 ? 1 : -1) * Math.exp(-2 * j * j * lambda * lambda);
    sum += term;
    if (Math.abs(term) < 1e-12) break;
  }
  return Math.min(1, Math.max(0, sum));
}

/**
 * Two-sample KS between the reference (through its profile) and current
 * values: D = sup |F_ref - F_cur|, checked on both sides of every point
 * either CDF steps at. The profile resolves the reference CDF to within one
 * quantile step (for a discrete value, its probability lies anywhere in the
 * step its run of equal quantiles ends in); that much is taken off D so the
 * test never claims more than the summary can show. p by the asymptotic distribution with
 * Stephens' correction. O(m log m + k log k).
 */
export function ksTest(reference: Profile, current: ArrayLike<number>): { d: number; p: number } {
  const m = current.length;
  if (m === 0) return { d: 0, p: 1 };
  const q = reference.quantiles;
  const sorted = sortedOf(current);
  const points = [...new Set([...sorted, ...q])];
  let d = 0;
  for (const x of points) {
    for (const inclusive of [true, false]) {
      const fr = referenceCdf(q, x, inclusive);
      const fc = rank(sorted, x, inclusive) / m;
      d = Math.max(d, Math.abs(fr - fc));
    }
  }
  d = Math.max(0, d - 1 / (q.length - 1));
  const en = Math.sqrt((reference.n * m) / (reference.n + m));
  return { d, p: kolmogorovTail((en + 0.12 + 0.11 / en) * d) };
}

/**
 * Drift per feature: each current column against its profile. KS is judged
 * at alpha / (features tested), so more features don't mean more false alarms.
 */
export function featureDrift(
  profiles: Readonly<Record<string, Profile>>,
  current: Readonly<Record<string, ArrayLike<number>>>,
  rule: DriftRule = DRIFT_RULE,
): FeatureDrift[] {
  const names = Object.keys(profiles)
    .filter(f => current[f] !== undefined)
    .sort();
  const alpha = rule.alpha / Math.max(1, names.length);
  return names.map(feature => {
    const profile = profiles[feature];
    const values = current[feature] ?? [];
    if (!profile || values.length < rule.minCurrent)
      return { feature, psi: 0, ks: 0, p: 1, n: values.length, drifted: false };
    const p = psi(profile, values);
    const k = ksTest(profile, values);
    return { feature, psi: p, ks: k.d, p: k.p, n: values.length, drifted: p >= rule.psi && k.p < alpha };
  });
}

/** Profiles of each column of a row-major matrix (one row per example). */
export function profilesOf(rows: readonly (readonly number[])[], names: readonly string[]): Record<string, Profile> {
  const out: Record<string, Profile> = {};
  names.forEach((name, j) => {
    const p = profileOf(rows.map(r => r[j] ?? 0));
    if (p) out[name] = p;
  });
  return out;
}

/** Columns of a row-major matrix, by name. */
export function columnsOf(rows: readonly (readonly number[])[], names: readonly string[]): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  names.forEach((name, j) => {
    out[name] = rows.map(r => r[j] ?? 0);
  });
  return out;
}
