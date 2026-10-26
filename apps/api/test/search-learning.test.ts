// Learning the search ranking (ADR 0015 part 6): interleaving, the online
// judge and the offline gate, as pure functions.
import { describe, expect, it } from 'vitest';
import { trainLambdaMart } from '../src/ml/lambdamart.ts';
import { seededRandom } from '../src/ml/linalg.ts';
import {
  isHeldOutPerson,
  MIN_GAIN,
  MIN_HELDOUT_PEOPLE,
  passesGate,
  trainSearchRankerAndEvaluate,
} from '../src/ml/train-search-ranker.ts';
import type { Found } from '../src/search/engine.ts';
import { rankingFeatures } from '../src/search/features.ts';
import { applySwap, chooseSwap } from '../src/search/interventions.ts';
import { judgeInterleaving, MIN_DECIDED, MIN_PEOPLE } from '../src/search/judge.ts';
import { BASELINE_RANKER, ordered, teamDraft } from '../src/search/rankers.ts';
import type { TrainingSearch } from '../src/search/ranker-data.ts';

const found = (id: string, over: Partial<Found> = {}): Found => ({
  id,
  title: `Question ${id}`,
  field: 'imports-customs',
  fieldName: 'Imports & Customs',
  answerCount: 0,
  lastAnsweredAt: null,
  similarity: null,
  wordRank: null,
  meaningRank: null,
  everyWord: false,
  ...over,
});

describe('team-draft interleaving', () => {
  it('takes turns, never repeats a result, and credits each to the side that picked it', () => {
    const a = ['1', '2', '3', '4'].map(id => found(id));
    const b = ['3', '1', '5', '6'].map(id => found(id));
    const r = seededRandom(1);
    for (let run = 0; run < 50; run++) {
      const shown = teamDraft(a, b, 6, r);
      const ids = shown.map(s => s.found.id);
      expect(new Set(ids).size).toBe(ids.length);
      const teamA = shown.filter(s => s.team === 'a').length;
      expect(Math.abs(teamA - (shown.length - teamA))).toBeLessThanOrEqual(1);
      // Each side contributes its own highest result not already shown.
      expect(['1', '3']).toContain(ids[0]);
    }
    // The coin decides who picks first when even.
    expect(teamDraft(a, b, 1, () => 0)[0]).toMatchObject({ team: 'a', found: { id: '1' } });
    expect(teamDraft(a, b, 1, () => 0.9)[0]).toMatchObject({ team: 'b', found: { id: '3' } });
    // One side running out leaves the other to fill the page.
    expect(teamDraft([found('1')], b, 4, () => 0).map(s => s.found.id)).toEqual(['1', '3', '5', '6']);
  });

  it('orders by a model when there is one, and keeps the engine’s order when there isn’t', () => {
    const items = [found('a', { wordRank: 3 }), found('b', { wordRank: 1, everyWord: true })];
    expect(ordered({ id: BASELINE_RANKER, model: null }, items).map(f => f.id)).toEqual(['a', 'b']);
    // A model that learned every-word matters.
    const inputs = (everyWord: boolean, wordRank: number) =>
      rankingFeatures({
        wordRank,
        meaningRank: null,
        similarity: null,
        everyWord,
        answerCount: 0,
        answerAgeDays: null,
      });
    const model = trainLambdaMart(
      Array.from({ length: 30 }, () => ({ features: [inputs(false, 3), inputs(true, 1)], labels: [0, 1] })),
      { trees: 5, minLeafSize: 1 },
    );
    expect(ordered({ id: 'lambdamart:v1', model }, items).map(f => f.id)).toEqual(['b', 'a']);
  });
});

describe('the online judge', () => {
  const searches = (people: number, perPerson: number, bWinsShare: number, seed = 1) => {
    const r = seededRandom(seed);
    return Array.from({ length: people * perPerson }, (_, i) => {
      const b = r() < bWinsShare;
      return { user: `p${String(i % people)}`, a: b ? 0 : 1, b: b ? 1 : 0 };
    });
  };

  it('waits for enough decided searches from enough people', () => {
    expect(judgeInterleaving(searches(MIN_PEOPLE - 1, 20, 0.9)).winner).toBeNull();
    expect(judgeInterleaving(searches(MIN_PEOPLE, Math.floor((MIN_DECIDED - 1) / MIN_PEOPLE), 0.9)).winner).toBeNull();
    // Ties never count as decided.
    expect(
      judgeInterleaving(Array.from({ length: 500 }, (_, i) => ({ user: `p${String(i % 50)}`, a: 1, b: 1 }))).decided,
    ).toBe(0);
  });

  it('names a clear winner either way, and no winner when it is close', () => {
    expect(judgeInterleaving(searches(60, 10, 0.75)).winner).toBe('challenger');
    expect(judgeInterleaving(searches(60, 10, 0.25)).winner).toBe('control');
    expect(judgeInterleaving(searches(60, 10, 0.5)).winner).toBeNull();
  });

  it('counts people, not searches: one heavy searcher can’t decide', () => {
    // 59 people slightly prefer the control; one person searches 2,000 times and always picks the challenger.
    const many = [...searches(59, 6, 0.4, 2), ...Array.from({ length: 2000 }, () => ({ user: 'heavy', a: 0, b: 1 }))];
    expect(judgeInterleaving(many).winner).not.toBe('challenger');
  });
});

/** Logged searches from a world where the logged order is mediocre and every-word marks what helps. */
function logged(searches: number, seed: number): TrainingSearch[] {
  const r = seededRandom(seed);
  return Array.from({ length: searches }, (_, n) => {
    const docs = Array.from({ length: 10 }, (_, i) => {
      const good = r() < 0.2;
      return {
        features: rankingFeatures({
          wordRank: i + 1,
          meaningRank: null,
          similarity: null,
          everyWord: good,
          answerCount: 0,
          answerAgeDays: null,
        }),
        good,
      };
    });
    const swap = chooseSwap(r, docs.length);
    const shown = applySwap(
      docs.map((d, i) => ({ ...d, ranked: i + 1 })),
      swap,
    );
    return {
      user: `u${String(n % 400)}`,
      swap,
      results: shown.map((d, i) => {
        const clicked = r() < (1 / (i + 1)) * (d.good ? 0.9 : 0.05);
        return { features: d.features, position: i + 1, ranked: d.ranked, label: clicked ? (r() < 0.7 ? 2 : 1) : 0 };
      }),
    };
  });
}

describe('the offline gate', () => {
  it(
    'passes a model that orders better than what was logged, as a candidate with its evidence',
    { timeout: 60_000 },
    () => {
      const searches = logged(40_000, 1);
      const result = trainSearchRankerAndEvaluate({ searches, serving: null, options: { trees: 40 } });
      // Trained only on people it isn't judged on.
      expect(result.dataset.trainingSearches).toBe(searches.filter(s => !isHeldOutPerson(s.user)).length);
      expect(result.decision.promote).toBe(true);
      expect(result.decision.difference?.low ?? 0).toBeGreaterThan(0);
      expect(result.artifact).not.toBeNull();
      expect(result.baseline.kind).toBe('logged');
      expect(result.dataset.heldOutPeople).toBeGreaterThanOrEqual(MIN_HELDOUT_PEOPLE);
      expect(result.params.propensities).toHaveLength(20);
    },
  );

  it('keeps no weights when it doesn’t pass, and says why', () => {
    const r = trainSearchRankerAndEvaluate({ searches: logged(300, 2), serving: null });
    expect(r.decision.promote).toBe(false);
    expect(r.artifact).toBeNull();
    expect(r.decision.reason).toMatch(/position bias|held-out/);
  });

  it('needs both a large enough gain and an interval clear of zero', () => {
    expect(passesGate({ mean: MIN_GAIN, low: 0.001 })).toBe(true);
    expect(passesGate({ mean: MIN_GAIN, low: 0 })).toBe(false);
    expect(passesGate({ mean: MIN_GAIN - 0.001, low: 0.005 })).toBe(false);
    expect(passesGate({ mean: 0.2, low: -0.01 })).toBe(false);
  });

  it('judges people it never learned from', () => {
    const people = Array.from({ length: 1000 }, (_, i) => `u${String(i)}`);
    const held = people.filter(isHeldOutPerson).length;
    expect(held / people.length).toBeGreaterThan(0.15);
    expect(held / people.length).toBeLessThan(0.25);
    expect(isHeldOutPerson('u1')).toBe(isHeldOutPerson('u1'));
  });
});
