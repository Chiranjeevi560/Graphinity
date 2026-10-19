import { describe, expect, it } from 'vitest';
import {
  answerRank,
  displayedReputation,
  medalFor,
  MU0,
  nextWeight,
  playGame,
  replay,
  SIGMA0,
  SIGNAL,
  specificity,
  wilsonLowerBound,
} from '../src/reputation.ts';

describe('reputation in one field (TrueSkill, spec §11.3)', () => {
  it('starts everyone at 0 shown, from μ 25 and σ 25/3', () => {
    expect(displayedReputation({ mu: MU0, sigma: SIGMA0 })).toBeCloseTo(0, 10);
  });

  it('rises with wins, falls with losses, and grows more certain either way', () => {
    const start = { mu: MU0, sigma: SIGMA0 };
    const won = playGame(start, true);
    const lost = playGame(start, false);
    expect(won.mu).toBeGreaterThan(start.mu);
    expect(lost.mu).toBeLessThan(start.mu);
    expect(won.sigma).toBeLessThan(start.sigma);
    expect(lost.sigma).toBeLessThan(start.sigma);
  });

  it('trusts a long record over a lucky start', () => {
    const lucky = displayedReputation(replay([true]));
    const proven = displayedReputation(replay(Array.from({ length: 40 }, (_, i) => i % 10 !== 0)));
    expect(proven).toBeGreaterThan(lucky);
    expect(proven).toBeLessThanOrEqual(100);
  });

  it('makes every medal bar reachable by a perfect record, and keeps mediocre records low', () => {
    const perfect = (n: number) => displayedReputation(replay(Array.from({ length: n }, () => true)));
    const rate = (p: number, n: number) => {
      let acc = 0;
      return displayedReputation(
        replay(
          Array.from({ length: n }, () => {
            acc += p;
            if (acc >= 1) {
              acc -= 1;
              return true;
            }
            return false;
          }),
        ),
      );
    };
    expect(perfect(10)).toBeGreaterThanOrEqual(45); // Bronze bar at Bronze's 10 picks
    expect(perfect(30)).toBeGreaterThanOrEqual(68); // Silver at 30
    expect(perfect(75)).toBeGreaterThanOrEqual(85); // Gold at 75
    expect(rate(0.9, 75)).toBeGreaterThan(rate(0.75, 75));
    expect(rate(0.75, 75)).toBeLessThan(45);
    expect(rate(0.5, 75)).toBe(0);
  });

  it('gives the same answer for the same history, so it can be recomputed any time', () => {
    const history = [true, true, false, true];
    expect(replay(history)).toEqual(replay(history));
    expect(replay([])).toEqual({ mu: MU0, sigma: SIGMA0 });
  });
});

describe('Wilson lower bound (spec §11.5)', () => {
  it('matches known values at 95%', () => {
    expect(wilsonLowerBound(0, 0)).toBe(0);
    expect(wilsonLowerBound(1, 1)).toBeCloseTo(0.2065, 4);
    expect(wilsonLowerBound(90, 100)).toBeCloseTo(0.8256, 4);
    expect(wilsonLowerBound(5, 10)).toBeCloseTo(0.2366, 4);
  });

  it('judges small samples cautiously', () => {
    expect(wilsonLowerBound(1, 1)).toBeLessThan(wilsonLowerBound(90, 100));
  });
});

describe('medals (spec §11.3, per field)', () => {
  it('climbs Verified, Bronze, Silver, Gold only when every bar is met', () => {
    expect(medalFor({ accepted: 2, reputation: 90, wilson: 1, topPercent: true })).toBeNull();
    expect(medalFor({ accepted: 3, reputation: 25, wilson: 0, topPercent: false })).toBe('verified');
    expect(medalFor({ accepted: 10, reputation: 45, wilson: 0.64, topPercent: false })).toBe('verified');
    expect(medalFor({ accepted: 10, reputation: 45, wilson: 0.65, topPercent: false })).toBe('bronze');
    expect(medalFor({ accepted: 30, reputation: 68, wilson: 0.78, topPercent: false })).toBe('silver');
    expect(medalFor({ accepted: 75, reputation: 85, wilson: 0.9, topPercent: false })).toBe('silver');
    expect(medalFor({ accepted: 75, reputation: 85, wilson: 0.9, topPercent: true })).toBe('gold');
  });
});

describe('expertise weight over time (spec §10.2)', () => {
  it('halves with no signal after one half-life', () => {
    expect(nextWeight(0.5, 0, 180, 180)).toBeCloseTo(0.25, 10);
  });

  it('moves towards 1 on a strong signal, and always stays within [0.01, 0.999]', () => {
    expect(nextWeight(0.5, SIGNAL.bestRatedHigh, 0, 180)).toBeCloseTo(0.5 + 0.08 * 1.5 * 0.5, 10);
    let w = 0.5;
    for (let i = 0; i < 10_000; i++) w = nextWeight(w, SIGNAL.bestRatedHigh, 0, 180);
    expect(w).toBeLessThanOrEqual(0.999);
    for (let i = 0; i < 10_000; i++) w = nextWeight(w, SIGNAL.false, 30, 180);
    expect(w).toBeGreaterThanOrEqual(0.01);
    expect(nextWeight(Number.NaN, 1, 0, 180)).toBe(0.01);
  });
});

describe('ordering answers (spec §11.5)', () => {
  it('adds the weighted parts exactly', () => {
    expect(answerRank({ best: true, wilson: 1, reputation: 1, clusterMass: 1, trust: 1, specificity: 1 })).toBeCloseTo(
      1,
      10,
    );
    expect(
      answerRank({ best: false, wilson: 0.5, reputation: 0, clusterMass: 0, trust: 0, specificity: 0 }),
    ).toBeCloseTo(0.11, 10);
  });

  it('rewards concrete detail over vague advice', () => {
    expect(specificity('Paid ₹94,800 at the Chennai airport counter in March, took 3 days.')).toBe(1);
    expect(specificity('Just be careful and it will be fine.')).toBe(0);
  });
});
