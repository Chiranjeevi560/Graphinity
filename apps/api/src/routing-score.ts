// The routing score Ψ(u, q) from docs/SPEC.md §11.2: who should a question
// be put to? Pure: the routing job gathers the facts (routing.ts), this
// weighs them, so every factor is tested on its own.
//
// Two of the spec's parts are left out until there is data for them, and
// say so rather than pretend: the time-of-day fit in φ8 needs each person's
// timezone, which we don't collect, and φ9 (diversity) needs person-to-
// person weights. Leaving φ9 out lowers everyone's score by the same 0.03,
// so the order is what the spec's would be.
import { wilsonLowerBound, type Skill } from './reputation.ts';

export const ALPHA = { proximity: 0.24, reputation: 0.18, country: 0.15, trust: 0.12, helpful: 0.1, selection: 0.08, responsiveness: 0.06, activity: 0.04 } as const;
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
}

export type Factors = Record<keyof typeof ALPHA, number>;

export function factors(c: Candidate): Factors {
  const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
  const timeTerm = c.medianReplySeconds === null ? 0.5 : Math.exp(-c.medianReplySeconds / REPLY_SCALE_SECONDS);
  return {
    proximity: Math.max(0, Math.min(1, c.proximity ?? 0)),
    reputation: sigmoid((c.skill.mu - 3 * c.skill.sigma - 25) / 8.33),
    country: c.resident ? 0.8 : c.pickedInCountry ? 0.5 : 0,
    trust: Math.max(0, Math.min(1, c.trust)),
    helpful: wilsonLowerBound(c.helped, c.answers),
    selection: (c.picks + 1) / (c.answers + 4),
    // No record counts as halfway: one reply in two tries.
    responsiveness: timeTerm * (c.answered + 1) / (c.asked + 2),
    activity: c.daysSinceActive === null ? 0 : Math.exp((-Math.LN2 * Math.max(0, c.daysSinceActive)) / ACTIVE_HALF_LIFE_DAYS),
  };
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
export function psi(c: Candidate, field: { routes: number; dailyLimit: number }, options: { explore?: boolean } = {}): number {
  if (c.usedToday >= field.dailyLimit) return 0;
  const f = factors(c);
  const sum = (Object.keys(ALPHA) as Array<keyof typeof ALPHA>).reduce((s, k) => s + ALPHA[k] * f[k], 0);
  const bonus = options.explore ? BETA_COLD * coldBonus(c.routesInField, field.routes) : 0;
  return (sum + bonus) * loadDampener(c.usedToday, field.dailyLimit);
}

/**
 * Graph trust (φ4): personalised PageRank over picks (asker → whose answer
 * they picked), starting only from trusted people (moderators), as
 * TrustRank does. Trust reaches someone only through a chain of picks from
 * a trusted person, so accounts picking each other in a closed ring gain
 * nothing. Scaled so the most trusted is 1; all 0 until a trusted person
 * has picked anyone.
 */
export function pageRank(people: readonly string[], picks: ReadonlyArray<readonly [string, string]>, trusted: readonly string[], damping = 0.85, rounds = 50): Map<string, number> {
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
