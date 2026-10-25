// The routing score Ψ(u, q) from docs/SPEC.md §11.2: who should a question
// be put to? Pure: the routing job gathers the facts (routing.ts), this
// weighs them, so every factor is tested on its own.
//
// Circadian fit uses the profile country and a central IANA timezone where
// possible. Diversity is recomputed greedily from stored answerer affinities.
import { wilsonLowerBound, type Skill } from './reputation.ts';

export const ALPHA = {
  proximity: 0.24,
  reputation: 0.18,
  country: 0.15,
  trust: 0.12,
  helpful: 0.1,
  selection: 0.08,
  responsiveness: 0.06,
  activity: 0.04,
  diversity: 0.03,
} as const;
export const BETA_COLD = 0.12;
/** The newcomer bonus lasts until someone has had this many questions in the field. */
export const COLD_UNTIL = 5;
/** φ7: a reply in 4 hours counts e⁻¹ of an instant one. */
const REPLY_SCALE_SECONDS = 14_400;
/** φ8: activity counts half after two weeks away (the spec gives no number). */
const ACTIVE_HALF_LIFE_DAYS = 14;

/** What the routing job knows about one person, in the question's field. */
export interface Candidate {
  /** Highest cosine between this question and those they answered before; null if none. */
  proximity: number | null;
  /** Their TrueSkill in the field (reputation.ts replay). */
  skill: Skill;
  /** Stored, field/country-specific competence weight updated from evaluations. */
  expertiseWeight: number;
  resident: boolean;
  /** One of their answers was picked on a question about this country. */
  pickedInCountry: boolean;
  /** Graph trust, 0 to 1 (pageRank below). */
  trust: number;
  helped: number;
  answers: number;
  picks: number;
  medianReplySeconds: number | null;
  /** Questions put to them, and how many of those they answered. */
  asked: number;
  answered: number;
  daysSinceActive: number | null;
  /** Questions in this field put to them, ever. */
  routesInField: number;
  usedToday: number;
  circadianFit: number;
  maxAffinityWithSelected: number;
}

export type Factors = Record<keyof typeof ALPHA, number>;

/**
 * The order factors are stored in (app.route_factors, migration 0016), and
 * its version. Changing what any factor means requires a new version, so a
 * model never learns from rows whose numbers meant something else.
 */
export const FACTOR_ORDER = Object.keys(ALPHA) as Array<keyof typeof ALPHA>;
export const FACTORS_VERSION = 1;

/** The stored vector: every factor, with diversity as it was applied when the person was chosen. */
export function factorVector(c: Candidate, diversity: number): number[] {
  const f = { ...factors(c), diversity: clamp(diversity) };
  return FACTOR_ORDER.map(k => clamp(f[k]));
}

/** Ψ's weighted sum over a stored vector (no newcomer bonus, no load): the baseline a learned model must beat. */
export function psiOfVector(vector: readonly number[]): number {
  return FACTOR_ORDER.reduce((s, k, i) => s + ALPHA[k] * (vector[i] ?? 0), 0);
}

export function factors(c: Candidate): Factors {
  const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
  const timeTerm = c.medianReplySeconds === null ? 0.5 : Math.exp(-c.medianReplySeconds / REPLY_SCALE_SECONDS);
  return {
    proximity: Math.max(0, Math.min(1, c.proximity ?? 0)),
    reputation: 0.8 * sigmoid((c.skill.mu - 3 * c.skill.sigma - 25) / 8.33) + 0.2 * clamp(c.expertiseWeight),
    country: c.resident ? 0.8 : c.pickedInCountry ? 0.5 : 0,
    trust: Math.max(0, Math.min(1, c.trust)),
    helpful: wilsonLowerBound(c.helped, c.answers),
    selection: (c.picks + 1) / (c.answers + 4),
    // No record counts as halfway: one reply in two tries.
    responsiveness: (timeTerm * (c.answered + 1)) / (c.asked + 2),
    activity:
      (c.daysSinceActive === null
        ? 0
        : Math.exp((-Math.LN2 * Math.max(0, c.daysSinceActive)) / ACTIVE_HALF_LIFE_DAYS)) * clamp(c.circadianFit),
    diversity: 1 - clamp(c.maxAffinityWithSelected),
  };
}

const countryTimeZones: Record<string, string> = {
  AE: 'Asia/Dubai',
  AR: 'America/Argentina/Buenos_Aires',
  AT: 'Europe/Vienna',
  AU: 'Australia/Adelaide',
  BD: 'Asia/Dhaka',
  BE: 'Europe/Brussels',
  BR: 'America/Sao_Paulo',
  CA: 'America/Winnipeg',
  CH: 'Europe/Zurich',
  CL: 'America/Santiago',
  CN: 'Asia/Shanghai',
  CO: 'America/Bogota',
  DE: 'Europe/Berlin',
  DK: 'Europe/Copenhagen',
  EG: 'Africa/Cairo',
  ES: 'Europe/Madrid',
  FI: 'Europe/Helsinki',
  FR: 'Europe/Paris',
  GB: 'Europe/London',
  GR: 'Europe/Athens',
  HK: 'Asia/Hong_Kong',
  ID: 'Asia/Jakarta',
  IE: 'Europe/Dublin',
  IL: 'Asia/Jerusalem',
  IN: 'Asia/Kolkata',
  IT: 'Europe/Rome',
  JP: 'Asia/Tokyo',
  KE: 'Africa/Nairobi',
  KR: 'Asia/Seoul',
  LK: 'Asia/Colombo',
  MX: 'America/Mexico_City',
  MY: 'Asia/Kuala_Lumpur',
  NG: 'Africa/Lagos',
  NL: 'Europe/Amsterdam',
  NP: 'Asia/Kathmandu',
  NZ: 'Pacific/Auckland',
  PK: 'Asia/Karachi',
  PH: 'Asia/Manila',
  PL: 'Europe/Warsaw',
  PT: 'Europe/Lisbon',
  RU: 'Asia/Novosibirsk',
  SA: 'Asia/Riyadh',
  SE: 'Europe/Stockholm',
  SG: 'Asia/Singapore',
  TH: 'Asia/Bangkok',
  TR: 'Europe/Istanbul',
  TW: 'Asia/Taipei',
  UA: 'Europe/Kyiv',
  US: 'America/Chicago',
  VN: 'Asia/Ho_Chi_Minh',
  ZA: 'Africa/Johannesburg',
};

/** Daytime suitability centered at 14:00; multi-zone countries use a central zone. */
export function circadianFit(country: string, now: Date): number {
  const timeZone = countryTimeZones[country];
  if (!timeZone || !Number.isFinite(now.getTime())) return 0.5;
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hourCycle: 'h23' }).format(now));
  const distance = Math.abs(hour - 14);
  return clamp(0.5 + 0.5 * Math.cos((Math.min(distance, 24 - distance) / 12) * Math.PI));
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

/** UCB1 √(2 ln N_f / (n + 1)) while someone has had fewer than 5 questions in the field. */
export function coldBonus(routesInField: number, fieldRoutes: number): number {
  if (routesInField >= COLD_UNTIL || fieldRoutes < 1) return 0;
  return Math.sqrt((2 * Math.log(fieldRoutes)) / (routesInField + 1));
}

/** ((B − used today) / B)^1.5: fewer questions as someone nears their daily limit. */
export function loadDampener(usedToday: number, limit: number): number {
  return Math.max(0, (limit - usedToday) / limit) ** 1.5;
}

/**
 * Ψ(u, q) = 𝟙budget · (Σ αₖ φₖ + β Ω_cold) · Γ_load.
 *
 * The newcomer bonus counts only for the wave's explore place (`explore`).
 * It grows with the field: past a few hundred questions it outweighs every
 * other factor together, so in the main places it would hand every wave to
 * people new to the field and crowd the experts out. The spec's own wave
 * plan, "4 exploit + 1 cold-start explore", keeps the two apart.
 */
export function psi(
  c: Candidate,
  field: { routes: number; dailyLimit: number },
  options: { explore?: boolean } = {},
): number {
  if (c.usedToday >= field.dailyLimit) return 0;
  const f = factors(c);
  const sum = (Object.keys(ALPHA) as Array<keyof typeof ALPHA>).reduce((s, k) => s + ALPHA[k] * f[k], 0);
  const bonus = options.explore ? BETA_COLD * coldBonus(c.routesInField, field.routes) : 0;
  return (sum + bonus) * loadDampener(c.usedToday, field.dailyLimit);
}

export interface DiverseOption {
  id: string;
  score: number;
  candidate: Pick<Candidate, 'usedToday'>;
}

/** Maximum learned affinity to an already selected recipient; O(k) per candidate. */
export function affinityToSelected(
  id: string,
  selected: readonly string[],
  affinities: ReadonlyMap<string, number>,
): number {
  return selected.reduce((max, other) => {
    const key = id < other ? `${id}:${other}` : `${other}:${id}`;
    return Math.max(max, clamp(affinities.get(key) ?? 0));
  }, 0);
}

/**
 * Greedy marginal selection with a field-local pairwise affinity penalty.
 * By default Ψ's own: score + α₉ · (1 − max affinity) · Γ_load. A learned
 * ranker passes `scoreWith` to re-score each option with its diversity
 * factor set to 1 − max affinity, on its own scale.
 */
export function greedyDiverse<T extends DiverseOption>(
  options: readonly T[],
  count: number,
  affinities: ReadonlyMap<string, number>,
  alreadySelected: readonly string[] = [],
  dailyLimit = 3,
  scoreWith?: (option: T, maxAffinity: number) => number,
): T[] {
  const selectedIds = [...alreadySelected];
  const remaining = new Map(options.map(option => [option.id, option]));
  const result: T[] = [];
  while (result.length < count && remaining.size > 0) {
    let best: T | undefined;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (const option of remaining.values()) {
      const maxAffinity = affinityToSelected(option.id, selectedIds, affinities);
      const score = scoreWith
        ? scoreWith(option, maxAffinity)
        : option.score + ALPHA.diversity * (1 - maxAffinity) * loadDampener(option.candidate.usedToday, dailyLimit);
      if (score > bestScore || (score === bestScore && best && option.id < best.id)) {
        best = option;
        bestScore = score;
      }
    }
    if (!best) break;
    result.push(best);
    selectedIds.push(best.id);
    remaining.delete(best.id);
  }
  return result;
}

/**
 * Graph trust (φ4): personalised PageRank over picks (asker → whose answer
 * they picked), starting only from trusted people (moderators), as
 * TrustRank does. Trust reaches someone only through a chain of picks from
 * a trusted person, so accounts picking each other in a closed ring gain
 * nothing. Scaled so the most trusted is 1; all 0 until a trusted person
 * has picked anyone.
 */
export function pageRank(
  people: readonly string[],
  picks: ReadonlyArray<readonly [string, string]>,
  trusted: readonly string[],
  damping = 0.85,
  rounds = 50,
): Map<string, number> {
  const known = new Set(people);
  const seeds = trusted.filter(t => known.has(t));
  const out = new Map<string, string[]>(people.map(p => [p, []]));
  for (const [from, to] of picks) if (known.has(from) && known.has(to) && from !== to) out.get(from)?.push(to);
  let rank = new Map(people.map(p => [p, seeds.includes(p) ? 1 / seeds.length : 0]));
  if (seeds.length > 0) {
    for (let i = 0; i < rounds; i++) {
      const next = new Map(people.map(p => [p, seeds.includes(p) ? (1 - damping) / seeds.length : 0]));
      for (const [p, r] of rank) {
        const targets = out.get(p) ?? [];
        // Someone who picked nobody hands their share back to the trusted.
        const share = targets.length ? targets : seeds;
        for (const t of share) next.set(t, (next.get(t) ?? 0) + (damping * r) / share.length);
      }
      rank = next;
    }
  }
  // The trusted themselves start the flow; their own score isn't earned.
  for (const s of seeds) rank.set(s, 0);
  const top = Math.max(0, ...rank.values());
  return new Map(people.map(p => [p, top > 0 ? (rank.get(p) ?? 0) / top : 0]));
}
