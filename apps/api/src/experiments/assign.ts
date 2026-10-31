// Layers and namespaces (Tang et al., Google, KDD 2010). Experiments in one layer
// share 10,000 hash buckets without overlapping, so two ranking formulas never
// meet; layers use independent salts, so a person can be in one experiment per
// layer without one's effect leaning on another's.
import { murmur3 } from './murmur.ts';

export const BUCKETS = 10_000;

export const bucketOf = (unit: string, salt: string) => murmur3(`${unit}:${salt}`) % BUCKETS;

export interface Experiment {
  id: string;
  bucketStart: number;
  /** Exclusive. */
  bucketEnd: number;
  /** Arm names with weights summing to 1. */
  arms: ReadonlyArray<{ name: string; weight: number }>;
}

/** The experiment and arm for this person in this layer, or null. Stable across calls. */
export function assign(
  unit: string,
  salt: string,
  experiments: readonly Experiment[],
): { experiment: string; arm: string } | null {
  const bucket = bucketOf(unit, salt);
  const e = experiments.find(x => bucket >= x.bucketStart && bucket < x.bucketEnd);
  if (!e) return null;
  // Rehash within the experiment, so arms don't depend on where its bucket range lies.
  const u = murmur3(`${unit}:${salt}:${e.id}`) / 2 ** 32;
  let sum = 0;
  for (const a of e.arms) {
    sum += a.weight;
    if (u < sum) return { experiment: e.id, arm: a.name };
  }
  return { experiment: e.id, arm: e.arms.at(-1)?.name ?? 'control' };
}

/** Whether a new bucket range overlaps any existing one in the layer. */
export const overlaps = (a: Pick<Experiment, 'bucketStart' | 'bucketEnd'>, list: readonly Experiment[]) =>
  list.some(b => a.bucketStart < b.bucketEnd && b.bucketStart < a.bucketEnd);
