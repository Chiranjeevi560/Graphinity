// The online simulation the exploration policy was chosen with (ADR 0014):
// its invariants, so the benchmark's evidence can be trusted.
import { describe, expect, it } from 'vitest';
import { simulateOnline, type Policy } from '../src/ml/routing-online-sim.ts';

const policies: Policy[] = ['greedy', 'psi-newcomer', 'epsilon', 'glm-ucb', 'thompson', 'thompson-gated'];

describe('the online routing simulation', () => {
  for (const world of ['independent', 'competing'] as const)
    it(`never lets a policy beat the oracle, and reports sane numbers (${world})`, { timeout: 120_000 }, () => {
      for (const policy of policies) {
        const r = simulateOnline({ policy, days: 5, questionsPerDay: 12, seed: 3, world, epsilon: 0.3, alpha: 1 });
        expect(r.questions).toBe(60);
        expect(r.regret).toBeGreaterThanOrEqual(-1e-9);
        expect(r.expectedHelped).toBeGreaterThan(0);
        for (const share of [r.gemsReached, r.gemsExploited]) {
          expect(share).toBeGreaterThanOrEqual(0);
          expect(share).toBeLessThanOrEqual(1);
        }
        expect(r.explorations).toBeLessThanOrEqual(r.questions);
      }
    });

  it('is reproducible for a seed', { timeout: 60_000 }, () => {
    const a = simulateOnline({ policy: 'thompson-gated', days: 4, questionsPerDay: 10, seed: 5 });
    const b = simulateOnline({ policy: 'thompson-gated', days: 4, questionsPerDay: 10, seed: 5 });
    expect({ ...a, decisionMs: 0 }).toEqual({ ...b, decisionMs: 0 });
  });

  it('starts every policy the same way: the newcomer place until a model exists', { timeout: 60_000 }, () => {
    // Day 0 has no model; from day 2 greedy never explores.
    const greedy = simulateOnline({ policy: 'greedy', days: 1, questionsPerDay: 10, seed: 2 });
    const newcomer = simulateOnline({ policy: 'psi-newcomer', days: 1, questionsPerDay: 10, seed: 2 });
    expect({ ...greedy, policy: 'x', decisionMs: 0 }).toEqual({ ...newcomer, policy: 'x', decisionMs: 0 });
  });

  it('shows the newcomer place costing more in the last place than exploitation’s choice', { timeout: 120_000 }, () => {
    const newcomer = simulateOnline({ policy: 'psi-newcomer', days: 6, questionsPerDay: 15, seed: 1 });
    const greedy = simulateOnline({ policy: 'greedy', days: 6, questionsPerDay: 15, seed: 1 });
    const cost = (r: typeof greedy) => (r.greedyLastPlace - r.lastPlace) / r.questions;
    expect(cost(newcomer)).toBeGreaterThan(cost(greedy) + 0.02);
    expect(newcomer.explorations).toBeGreaterThan(greedy.explorations);
  });
});
