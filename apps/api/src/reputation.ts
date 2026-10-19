// Field-specific reputation, as docs/SPEC.md §10.2, §11.3 and
// §11.5 define it. Pure maths: no database, no clock, so every number here
// can be checked by hand and by tests.
//
// TrueSkill (Herbrich, Minka and Graepel, 2007) keeps a belief about each
// person's skill in one field as a normal distribution N(μ, σ²). Each time
// an asker judges one of their answers, it is a game (see OPPONENT_GAP): a pick, a helpful mark or "turned out right" is a win; "turned
// out wrong", or a pick rated 2 stars or less, is a loss. Wins raise μ,
// every game shrinks σ, and the shown score is the cautious μ − 3σ, so a
// lucky newcomer can't outrank someone with a long record.

/** Spec §11.3: everyone starts at μ₀ = 25, σ₀ = 25/3. */
export const MU0 = 25;
export const SIGMA0 = 25 / 3;
/** Standard TrueSkill choices: performance noise β = σ₀/2, drift τ = σ₀/100. */
const BETA = SIGMA0 / 2;
const TAU = SIGMA0 / 100;
/**
 * Each judgement is a game against yourself, 8 skill points weaker (about
 * one σ₀). The spec fixes the medal bars (§11.3) but not the opponent, so
 * this was calibrated to them: against a fixed newcomer, 200 perfect
 * judgements reach only 84 and Gold's 85 is unreachable; against an equal,
 * 30 reach 100 and volume alone maxes the score. With the gap, perfect
 * records reach 24 / 50 / 77 / 99 after 3 / 10 / 30 / 75 judgements (the
 * Verified / Bronze / Silver / Gold counts), while 90% right over 75 gives
 * 60, 75% right 28, and 50% right 0. Tested in reputation.test.ts.
 */
export const OPPONENT_GAP = 8;

export interface Skill {
  mu: number;
  sigma: number;
}

/** Spec §11.3: R = max(0, (μ − 3σ) × 2), 0 to 100. Starts at 0. */
export function displayedReputation({ mu, sigma }: Skill): number {
  return Math.min(100, Math.max(0, (mu - 3 * sigma) * 2));
}

/** One judged answer: did the asker's judgement count as a win for its author? */
export function playGame(skill: Skill, won: boolean): Skill {
  const opponent = { mu: skill.mu - OPPONENT_GAP, sigma: SIGMA0 };
  const sigma2 = skill.sigma ** 2 + TAU ** 2;
  const c = Math.sqrt(2 * BETA ** 2 + sigma2 + opponent.sigma ** 2);
  const t = ((won ? 1 : -1) * (skill.mu - opponent.mu)) / c;
  const v = gaussianPdf(t) / Math.max(gaussianCdf(t), 1e-12);
  const w = v * (v + t);
  return {
    mu: skill.mu + (won ? 1 : -1) * (sigma2 / c) * v,
    sigma: Math.sqrt(sigma2 * Math.max(1 - (sigma2 / c ** 2) * w, 1e-6)),
  };
}

/** Replays judgements in order, from the starting belief. Same judgements, same result. */
export function replay(outcomes: readonly boolean[]): Skill {
  return outcomes.reduce<Skill>((skill, won) => playGame(skill, won), { mu: MU0, sigma: SIGMA0 });
}

/**
 * Spec §11.5: the lower bound of the Wilson score interval for h good
 * out of n, at 95% (z = 1.96). Small samples are judged cautiously: 1 of 1
 * scores far below 90 of 100.
 */
export function wilsonLowerBound(h: number, n: number, z = 1.96): number {
  if (n <= 0) return 0;
  const p = h / n;
  const z2 = z * z;
  return (p + z2 / (2 * n) - z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / (1 + z2 / n);
}

export type Medal = 'verified' | 'bronze' | 'silver' | 'gold';

export interface FieldRecord {
  /** Answers the asker picked as best, in this field. */
  accepted: number;
  reputation: number;
  wilson: number;
  /** In the top 1% of active people in this field and country. */
  topPercent: boolean;
}

/** Spec §11.3 medal tiers, per field, never global. */
export function medalFor(r: FieldRecord): Medal | null {
  if (r.topPercent && r.accepted >= 75 && r.reputation >= 85) return 'gold';
  if (r.accepted >= 30 && r.reputation >= 68 && r.wilson >= 0.78) return 'silver';
  if (r.accepted >= 10 && r.reputation >= 45 && r.wilson >= 0.65) return 'bronze';
  if (r.accepted >= 3 && r.reputation >= 25) return 'verified';
  return null;
}

/** Spec §10.2 reinforcement signals R(a, q). */
export const SIGNAL = { bestRatedHigh: 1.5, helpful: 0.65, ignored: -0.05, false: -0.8 } as const;

/**
 * Spec §10.2: an expertise weight fades with time (half-life per field)
 * and moves towards 1 on good signals, by learning rate η = 0.08, kept
 * within [0.01, 0.999].
 */
export function nextWeight(
  weight: number,
  signal: number,
  daysSince: number,
  halfLifeDays: number,
  eta = 0.08,
): number {
  const lambda = Math.LN2 / halfLifeDays;
  const next = weight * Math.exp(-lambda * Math.max(0, daysSince)) + eta * signal * (1 - weight);
  return Math.min(0.999, Math.max(0.01, Number.isFinite(next) ? next : 0.01));
}

export interface RankInputs {
  best: boolean;
  /** Wilson lower bound of the answer's helpful votes. */
  wilson: number;
  /** Author's reputation in this field, 0 to 1. */
  reputation: number;
  /** Trust-weighted share of the answer's consensus cluster, 0 to 1. */
  clusterMass: number;
  trust: number;
  specificity: number;
}

/** Spec §11.5: Ω = 0.30·best + 0.22·Wilson + 0.18·R + 0.12·M(C) + 0.10·Trust + 0.08·specificity. */
export function answerRank(a: RankInputs): number {
  return (
    0.3 * (a.best ? 1 : 0) +
    0.22 * a.wilson +
    0.18 * a.reputation +
    0.12 * a.clusterMass +
    0.1 * a.trust +
    0.08 * a.specificity
  );
}

/**
 * How concrete an answer is, 0 to 1 (spec §11.5 Q_specificity): numbers,
 * amounts, dates and named steps count; vague advice doesn't.
 */
export function specificity(text: string): number {
  const signs = [
    /\d/, // any figure
    /[₹$€£¥]\s?\d|\b\d[\d,.]*\s?(?:rs|inr|usd|eur|gbp|aed|lakh|crore|k)\b/i, // an amount
    /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b|\b(?:19|20)\d{2}\b|\b\d+\s?(?:days?|weeks?|months?|hours?)\b/i, // when, how long
    /\b(?:form|receipt|invoice|counter|office|desk|portal|airport|port|appointment|document)\b/i, // named steps
  ];
  return signs.filter(re => re.test(text)).length / signs.length;
}

// The standard normal distribution. Φ through erfc with a Chebyshev fit
// (Numerical Recipes, error below 1.2e-7): plenty for ranking people.
function gaussianPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

function gaussianCdf(x: number): number {
  return 0.5 * erfc(-x / Math.SQRT2);
}

function erfc(x: number): number {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const r =
    t *
    Math.exp(
      -z * z -
        1.26551223 +
        t *
          (1.00002368 +
            t *
              (0.37409196 +
                t *
                  (0.09678418 +
                    t *
                      (-0.18628806 +
                        t *
                          (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))),
    );
  return x >= 0 ? r : 2 - r;
}
