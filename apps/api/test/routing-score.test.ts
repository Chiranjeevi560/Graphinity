import { describe, expect, it } from 'vitest';
import { MU0, SIGMA0 } from '../src/reputation.ts';
import {
  ALPHA,
  BETA_COLD,
  coldBonus,
  factors,
  loadDampener,
  pageRank,
  psi,
  type Candidate,
} from '../src/routing-score.ts';

const base: Candidate = {
  proximity: null,
  skill: { mu: MU0, sigma: SIGMA0 },
  resident: false,
  pickedInCountry: false,
  trust: 0,
  helped: 0,
  answers: 0,
  picks: 0,
  medianReplySeconds: null,
  asked: 0,
  answered: 0,
  daysSinceActive: null,
  routesInField: 10,
  usedToday: 0,
};
const field = { routes: 100, dailyLimit: 3 };

describe('the spec’s routing weights (§11.2)', () => {
  it('are the table’s, adding up to 1 with diversity (left out: no person-to-person weights yet)', () => {
    expect(ALPHA).toEqual({
      proximity: 0.24,
      reputation: 0.18,
      country: 0.15,
      trust: 0.12,
      helpful: 0.1,
      selection: 0.08,
      responsiveness: 0.06,
      activity: 0.04,
    });
    expect(Object.values(ALPHA).reduce((a, b) => a + b, 0) + 0.03).toBeCloseTo(1, 10);
    expect(BETA_COLD).toBe(0.12);
  });
});

describe('each factor, 0 to 1', () => {
  it('φ1: how close in meaning to what they answered before', () => {
    expect(factors({ ...base, proximity: 0.83 }).proximity).toBeCloseTo(0.83, 10);
    expect(factors({ ...base, proximity: -0.2 }).proximity).toBe(0);
    expect(factors(base).proximity).toBe(0);
  });

  it('φ2: sigmoid of the cautious reputation, (μ − 3σ − 25) / 8.33', () => {
    expect(factors(base).reputation).toBeCloseTo(1 / (1 + Math.exp(3.0012)), 3);
    expect(factors({ ...base, skill: { mu: 40, sigma: 3 } }).reputation).toBeCloseTo(
      1 / (1 + Math.exp(-(40 - 9 - 25) / 8.33)),
      10,
    );
  });

  it('φ3: 0.8 living there, 0.5 picked before about there, else 0', () => {
    expect(factors({ ...base, resident: true, pickedInCountry: true }).country).toBe(0.8);
    expect(factors({ ...base, pickedInCountry: true }).country).toBe(0.5);
    expect(factors(base).country).toBe(0);
  });

  it('φ5: Wilson lower bound of helpful answers; φ6: picks smoothed (b + 1) / (n + 4)', () => {
    const f = factors({ ...base, helped: 8, answers: 10, picks: 3 });
    expect(f.helpful).toBeGreaterThan(0.45);
    expect(f.helpful).toBeLessThan(0.8);
    expect(f.selection).toBeCloseTo(4 / 14, 10);
    expect(factors(base).selection).toBeCloseTo(0.25, 10);
  });

  it('φ7: quick and reliable repliers score higher; no record counts as halfway', () => {
    const quick = factors({ ...base, medianReplySeconds: 1800, asked: 10, answered: 9 }).responsiveness;
    const slow = factors({ ...base, medianReplySeconds: 86_400, asked: 10, answered: 9 }).responsiveness;
    const ignores = factors({ ...base, medianReplySeconds: 1800, asked: 10, answered: 1 }).responsiveness;
    expect(quick).toBeCloseTo(Math.exp(-1800 / 14_400) * (10 / 12), 10);
    expect(slow).toBeLessThan(quick);
    expect(ignores).toBeLessThan(quick);
    expect(factors(base).responsiveness).toBeCloseTo(0.5 * 0.5, 10);
  });

  it('φ8: fades with time since they were last active, half in two weeks', () => {
    expect(factors({ ...base, daysSinceActive: 0 }).activity).toBe(1);
    expect(factors({ ...base, daysSinceActive: 14 }).activity).toBeCloseTo(0.5, 10);
    expect(factors(base).activity).toBe(0);
  });
});

describe('the newcomer bonus and the load dampener', () => {
  it('UCB1 √(2 ln N / (n + 1)) while someone has had fewer than 5 questions in the field', () => {
    expect(coldBonus(0, 100)).toBeCloseTo(Math.sqrt(2 * Math.log(100)), 10);
    expect(coldBonus(4, 100)).toBeCloseTo(Math.sqrt((2 * Math.log(100)) / 5), 10);
    expect(coldBonus(5, 100)).toBe(0);
    expect(coldBonus(0, 0)).toBe(0);
  });

  it('((B − used) / B)^1.5, and nothing at the limit', () => {
    expect(loadDampener(0, 3)).toBe(1);
    expect(loadDampener(1, 3)).toBeCloseTo((2 / 3) ** 1.5, 10);
    expect(loadDampener(3, 3)).toBe(0);
    expect(loadDampener(5, 3)).toBe(0);
  });
});

describe('Ψ, the whole score', () => {
  it('is the weighted factors plus the newcomer bonus, damped by today’s load', () => {
    const c = {
      ...base,
      proximity: 0.9,
      resident: true,
      trust: 0.5,
      helped: 4,
      answers: 5,
      picks: 2,
      medianReplySeconds: 3600,
      asked: 5,
      answered: 4,
      daysSinceActive: 1,
      routesInField: 2,
      usedToday: 1,
    };
    const f = factors(c);
    const sum = (Object.keys(ALPHA) as Array<keyof typeof ALPHA>).reduce((s, k) => s + ALPHA[k] * f[k], 0);
    expect(psi(c, field, { explore: true })).toBeCloseTo(
      (sum + BETA_COLD * coldBonus(2, 100)) * loadDampener(1, 3),
      10,
    );
    expect(psi(c, field)).toBeCloseTo(sum * loadDampener(1, 3), 10);
    expect(psi({ ...c, usedToday: 3 }, field)).toBe(0);
  });

  it('adds the newcomer bonus only for the explore place, so it can never crowd experts out of the rest', () => {
    const big = { routes: 1000, dailyLimit: 3 };
    // Answered close questions, lives there, picked 3 times in 8, replies within the hour.
    const expert = {
      ...base,
      proximity: 0.7,
      skill: { mu: 30, sigma: 4 },
      helped: 5,
      answers: 8,
      picks: 3,
      resident: true,
      routesInField: 12,
      daysSinceActive: 1,
      medianReplySeconds: 3600,
      asked: 12,
      answered: 9,
    };
    const unknown = { ...base, routesInField: 0 };
    // With the bonus, someone who has done nothing in the field outranks them...
    expect(psi(unknown, big, { explore: true })).toBeGreaterThan(psi(expert, big, { explore: true }));
    // ...so the main places rank without it.
    expect(psi(expert, big)).toBeGreaterThan(psi(unknown, big) * 5);
    expect(psi(unknown, big)).toBeCloseTo(psi(unknown, big, { explore: true }) - BETA_COLD * coldBonus(0, 1000), 10);
  });

  it('puts someone who answered close questions well above a stranger to the topic', () => {
    const seasoned = {
      ...base,
      proximity: 0.92,
      skill: { mu: 38, sigma: 3 },
      helped: 9,
      answers: 10,
      picks: 6,
      routesInField: 20,
      daysSinceActive: 2,
      medianReplySeconds: 2400,
      asked: 10,
      answered: 9,
    };
    const stranger = { ...base, routesInField: 20 };
    expect(psi(seasoned, field)).toBeGreaterThan(psi(stranger, field) + 0.3);
  });
});

describe('graph trust: PageRank from trusted people, along who picked whose answers', () => {
  it('flows from the trusted to those they picked, and on to those those people picked; the top is 1', () => {
    const pr = pageRank(
      ['mod', 'a', 'b', 'c'],
      [
        ['mod', 'a'],
        ['a', 'b'],
      ],
      ['mod'],
    );
    expect(pr.get('a')).toBe(1);
    expect(pr.get('b') ?? 0).toBeGreaterThan(0);
    expect(pr.get('b') ?? 0).toBeLessThan(1);
    expect(pr.get('c')).toBe(0);
  });

  it('gives a closed ring picking each other nothing when no trusted person ever picked them', () => {
    const pr = pageRank(
      ['r1', 'r2', 'r3', 'honest', 'mod'],
      [
        ['r1', 'r2'],
        ['r2', 'r3'],
        ['r3', 'r1'],
        ['mod', 'honest'],
      ],
      ['mod'],
    );
    expect(pr.get('honest')).toBe(1);
    expect(pr.get('r1')).toBe(0);
    expect(pr.get('r2')).toBe(0);
  });

  it('is zero for everyone until a trusted person has picked someone: no one gains or loses', () => {
    expect([...pageRank(['a', 'b'], [['a', 'b']], []).values()]).toEqual([0, 0]);
    expect([...pageRank(['mod', 'a'], [], ['mod']).values()]).toEqual([0, 0]);
    expect(pageRank([], [], []).size).toBe(0);
  });
});
