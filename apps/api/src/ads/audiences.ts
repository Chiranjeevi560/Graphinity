// Audiences (docs/adr/0022-advertising-platform.md part 7): groups of people
// a business can reach, known only by their rotating ad identities. Pure and
// deterministic; the build job (audience-build.ts) loads the inputs and stores
// the members. Three kinds:
// - segment: a rule over first-party signals (interest topics, country, the
//   topics someone set on their profile);
// - retargeting ("ad reminders"): people who recently tapped one of the
//   business's ads;
// - look-alike: people whose interests resemble a seed audience's.
// No audience with fewer than MIN_AUDIENCE people can be used or even sized:
// a small group is close to a list of individuals.

/** The smallest audience that may be targeted or sized (charter §3.2: k ≥ 100). */
export const MIN_AUDIENCE = 100;

export interface Person {
  adId: string;
  country: string | null;
  /** Topics set on the profile. */
  fields: readonly string[];
  /** Decayed interest score per topic. */
  interests: ReadonlyMap<string, number>;
}

/**
 * A segment rule: every condition in `all` must hold and, if `any` is given,
 * at least one of it. An interest counts at or above `min` (decayed score).
 */
export type Condition = { interest: string; min?: number } | { country: string } | { field: string };
export interface SegmentRule {
  all: readonly Condition[];
  any?: readonly Condition[];
}

const SLUG = /^[a-z]+(-[a-z]+)*$/;
const COUNTRY = /^[A-Z]{2}$/;

function parseCondition(x: unknown): Condition | null {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return null;
  const o = x as Record<string, unknown>;
  const keys = Object.keys(o).sort().join(',');
  if (keys === 'country' && typeof o.country === 'string' && COUNTRY.test(o.country)) return { country: o.country };
  if (keys === 'field' && typeof o.field === 'string' && SLUG.test(o.field)) return { field: o.field };
  if ((keys === 'interest' || keys === 'interest,min') && typeof o.interest === 'string' && SLUG.test(o.interest)) {
    if (o.min === undefined) return { interest: o.interest };
    if (typeof o.min === 'number' && Number.isFinite(o.min) && o.min > 0 && o.min <= 1000)
      return { interest: o.interest, min: o.min };
  }
  return null;
}

/** A stored rule, checked again on use: anything malformed matches nobody. */
export function parseRule(x: unknown): SegmentRule | null {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return null;
  const o = x as Record<string, unknown>;
  const list = (v: unknown, max: number) => (Array.isArray(v) && v.length <= max ? v.map(parseCondition) : null);
  const all = list(o.all, 20);
  const any = o.any === undefined ? [] : list(o.any, 20);
  if (!all?.length || !any || Object.keys(o).some(k => k !== 'all' && k !== 'any')) return null;
  if (all.some(c => c === null) || any.some(c => c === null)) return null;
  return { all: all as Condition[], any: any as Condition[] };
}

/** The decayed score from which an interest counts, as in serving (serve.ts). */
export const INTEREST_FLOOR = 0.5;

export function holds(c: Condition, p: Person): boolean {
  if ('interest' in c) return (p.interests.get(c.interest) ?? 0) >= (c.min ?? INTEREST_FLOOR);
  if ('country' in c) return p.country === c.country;
  return p.fields.includes(c.field);
}

export function inSegment(rule: SegmentRule, p: Person): boolean {
  if (!rule.all.every(c => holds(c, p))) return false;
  return !rule.any?.length || rule.any.some(c => holds(c, p));
}

/** An interest vector over a fixed topic order, L2-normalized (zero stays zero). */
export function interestVector(p: Person, topics: readonly string[]): Float64Array {
  const v = new Float64Array(topics.length);
  let norm = 0;
  topics.forEach((t, i) => {
    const x = p.interests.get(t) ?? 0;
    v[i] = x;
    norm += x * x;
  });
  if (norm > 0) {
    const s = 1 / Math.sqrt(norm);
    for (let i = 0; i < v.length; i++) v[i] = (v[i] ?? 0) * s;
  }
  return v;
}

const dot = (a: Float64Array, b: Float64Array) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] ?? 0) * (b[i] ?? 0);
  return s;
};

function normalize(v: Float64Array): Float64Array {
  const n = Math.sqrt(dot(v, v));
  if (n > 0) for (let i = 0; i < v.length; i++) v[i] = (v[i] ?? 0) / n;
  return v;
}

/** The normalized mean direction of some vectors. */
export function centroid(vectors: readonly Float64Array[], d: number): Float64Array {
  const c = new Float64Array(d);
  for (const v of vectors) for (let i = 0; i < d; i++) c[i] = (c[i] ?? 0) + (v[i] ?? 0);
  return normalize(c);
}

/**
 * Spherical k-means (Dhillon & Modha 2001): centres are unit vectors, a
 * vector joins the centre it has the largest cosine with. Seeded by
 * k-means++ over cosine distance with a fixed generator, so a build is
 * reproducible. O(iterations · n · k · d).
 */
export function sphericalKMeans(
  vectors: readonly Float64Array[],
  k: number,
  random: () => number,
  iterations = 20,
): Float64Array[] {
  const [first] = vectors;
  if (!first || k <= 0) return [];
  const d = first.length;
  const centres: Float64Array[] = [Float64Array.from(vectors[Math.floor(random() * vectors.length)] ?? first)];
  while (centres.length < Math.min(k, vectors.length)) {
    // k-means++: the next centre far (1 - cosine) from those chosen, with probability by distance squared.
    const far = vectors.map(v => {
      const best = centres.reduce((m, c) => Math.max(m, dot(v, c)), -1);
      return Math.max(0, 1 - best) ** 2;
    });
    const total = far.reduce((s, x) => s + x, 0);
    if (total === 0) break;
    let r = random() * total;
    let pick = 0;
    for (; pick < far.length - 1; pick++) {
      r -= far[pick] ?? 0;
      if (r <= 0) break;
    }
    centres.push(Float64Array.from(vectors[pick] ?? first));
  }
  const assignment = new Int32Array(vectors.length).fill(-1);
  for (let it = 0; it < iterations; it++) {
    let moved = false;
    for (const [i, v] of vectors.entries()) {
      let best = 0;
      let bestSim = -Infinity;
      for (const [j, c] of centres.entries()) {
        const sim = dot(v, c);
        if (sim > bestSim) {
          bestSim = sim;
          best = j;
        }
      }
      if (assignment[i] !== best) {
        assignment[i] = best;
        moved = true;
      }
    }
    if (!moved) break;
    centres.forEach((_, j) => {
      const members = vectors.filter((_, i) => assignment[i] === j);
      // A centre that lost every member keeps its place rather than collapsing to zero.
      if (members.length) centres[j] = centroid(members, d);
    });
  }
  return centres;
}

/** How strongly the global direction is taken off each score (charter §3.2's β_pop). */
export const POPULARITY_WEIGHT = 0.5;
export type Expansion = 0.01 | 0.02 | 0.05;

export interface LookAlike {
  /** Chosen people, best first. Empty when the result would be smaller than MIN_AUDIENCE. */
  members: string[];
  centres: number;
  /** The lowest chosen score (for the record). */
  threshold: number | null;
}

/**
 * A look-alike audience: K = min(8, ⌊|seed| / 25⌋) spherical k-means centres
 * over the seed's interest vectors; each candidate outside the seed scores
 * max_k(⟨u, μ_k⟩) − β⟨u, μ_global⟩, which stops people who like everything
 * popular from looking like everyone. The top `expansion` share of eligible
 * candidates by score, among those scoring above zero. Seeds under
 * MIN_AUDIENCE, or results under it, give nothing.
 *
 * Every candidate is scored, O(n · K · d), since choosing a top percentile
 * needs every score; at 100 million people this runs as a sharded batch job
 * with a streaming top-k per shard (ADR 0022 part 7), not an ANN query, which
 * can't return "the top 1%".
 */
export function lookAlike(
  seed: readonly Person[],
  candidates: readonly Person[],
  topics: readonly string[],
  expansion: Expansion,
  random: () => number,
): LookAlike {
  const none = (centres = 0): LookAlike => ({ members: [], centres, threshold: null });
  if (seed.length < MIN_AUDIENCE) return none();
  const seedIds = new Set(seed.map(p => p.adId));
  const vectors = seed.map(p => interestVector(p, topics)).filter(v => dot(v, v) > 0);
  const k = Math.min(8, Math.floor(seed.length / 25));
  const centres = sphericalKMeans(vectors, k, random);
  const eligible = candidates.filter(p => !seedIds.has(p.adId));
  const all = eligible.map(p => interestVector(p, topics));
  const global = centroid(all, topics.length);
  const scored = eligible
    .map((p, i) => {
      const u = all[i] ?? new Float64Array(topics.length);
      const near = centres.reduce((m, c) => Math.max(m, dot(u, c)), -Infinity);
      return { adId: p.adId, score: near - POPULARITY_WEIGHT * dot(u, global) };
    })
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score || (a.adId < b.adId ? -1 : 1));
  const take = Math.floor(eligible.length * expansion);
  const chosen = scored.slice(0, take);
  if (chosen.length < MIN_AUDIENCE) return none(centres.length);
  return { members: chosen.map(s => s.adId), centres: centres.length, threshold: chosen.at(-1)?.score ?? null };
}

/** Retargeting caps (charter §3.2): a reminder is shown at most this often to one person. */
export const RETARGET_PER_DAY = 3;
export const RETARGET_PER_WEEK = 7;
/** Reminders cool with time since the tap: weight e^(−Δt/τ), τ = 7 days. */
export const RETARGET_TAU_MS = 7 * 86_400_000;
/** Taps older than this don't add anyone to a reminder audience. */
export const RETARGET_WINDOW_MS = 30 * 86_400_000;

export const cooling = (sinceMs: number) => Math.exp(-Math.max(0, sinceMs) / RETARGET_TAU_MS);

/** The size an advertiser may see: unknown below the floor, otherwise rounded down to a hundred. */
export const shownSize = (size: number): number | null => (size < MIN_AUDIENCE ? null : Math.floor(size / 100) * 100);
