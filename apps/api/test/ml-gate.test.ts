import { describe, expect, it } from 'vitest';
import { bm25Index } from '../src/ml/bm25.ts';
import {
  bm25Scorer,
  decide,
  evaluateRetrieval,
  isHeldOut,
  MIN_QUERIES,
  type HeldOutQuestion,
  type RetrievalScores,
} from '../src/ml/embedding-gate.ts';

describe('BM25', () => {
  it('ranks the document sharing the query’s words first, rare words counting more', () => {
    const index = bm25Index(['customs duty on a watch', 'visa for a chef', 'duty free shopping at the airport']);
    const scores = [0, 1, 2].map(i => index.score('watch customs duty', i));
    expect(scores[0]).toBeGreaterThan(scores[2] ?? 0);
    expect(scores[2]).toBeGreaterThan(scores[1] ?? 0);
    expect(scores[1]).toBe(0);
  });
});

describe('the held-out split', () => {
  it('holds out about one question in five, the same ones every time', () => {
    const ids = Array.from({ length: 5000 }, (_, i) => String(i + 1));
    const held = ids.filter(isHeldOut);
    expect(held.length / ids.length).toBeGreaterThan(0.17);
    expect(held.length / ids.length).toBeLessThan(0.23);
    expect(ids.filter(isHeldOut)).toEqual(held);
  });
});

const questions: HeldOutQuestion[] = Array.from({ length: 40 }, (_, i) => ({
  id: String(i),
  title: `title number ${String(i)}`,
  body: `details of question ${String(i)} written in enough words to count`,
}));

describe('evaluateRetrieval', () => {
  it('scores a perfect ranker 1 and counts ties against the target', () => {
    const perfect = evaluateRetrieval(questions, (_q, c) =>
      c === questions.findIndex(x => _q.includes(` ${x.id} `)) ? 1 : 0,
    );
    expect(perfect).toMatchObject({ queries: 40, mrr: 1, recallAt10: 1 });
    const flat = evaluateRetrieval(questions, () => 0);
    expect(flat.mrr).toBeCloseTo(1 / 40, 10);
    expect(flat.recallAt10).toBe(0);
  });

  it('skips details too short to be a fair query', () => {
    const short = [...questions.slice(0, 5), { id: 'x', title: 't', body: 'too short' }];
    expect(evaluateRetrieval(short, () => 0).queries).toBe(5);
  });

  it('uses word matching as the baseline', () => {
    const qs = [
      { id: '1', title: 'customs duty on a watch', body: 'how much customs duty will my watch need here' },
      { id: '2', title: 'work visa for a chef', body: 'how long does a work visa take for a chef' },
    ];
    expect(evaluateRetrieval(qs, bm25Scorer(qs)).mrr).toBe(1);
  });
});

const scores = (reciprocalRanks: number[]): RetrievalScores => ({
  queries: reciprocalRanks.length,
  mrr: reciprocalRanks.reduce((s, x) => s + x, 0) / reciprocalRanks.length,
  recallAt10: 0,
  reciprocalRanks,
});

describe('decide', () => {
  it('promotes a model that is better beyond noise', () => {
    const base = Array.from({ length: 60 }, (_, i) => 1 / (2 + (i % 5)));
    const better = base.map(x => Math.min(1, x + 0.2));
    const d = decide(scores(better), scores(base));
    expect(d.promote).toBe(true);
    expect(d.difference?.low).toBeGreaterThan(0);
  });

  it('does not promote an equal model, or one better only on a lucky few', () => {
    const base = Array.from({ length: 60 }, (_, i) => 1 / (1 + (i % 7)));
    expect(decide(scores(base), scores(base)).promote).toBe(false);
    // Much better on 2 questions, slightly worse on the other 58: better on average
    // (+0.009), but only because of two questions. The interval must say "not proven".
    const lucky = base.map((x, i) => (i === 5 || i === 6 ? 1 : Math.max(0, x - 0.02)));
    const mean = lucky.reduce((s, x, i) => s + x - (base[i] ?? 0), 0) / lucky.length;
    expect(mean).toBeGreaterThan(0);
    const d = decide(scores(lucky), scores(base));
    expect(d.promote).toBe(false);
    expect(d.difference?.low).toBeLessThan(0);
  });

  it(`does not decide below ${String(MIN_QUERIES)} questions`, () => {
    const d = decide(scores([1, 1, 1]), scores([0, 0, 0]));
    expect(d).toMatchObject({ promote: false, difference: null });
    expect(d.reason).toMatch(/only 3 evaluable/);
  });

  it('refuses to compare scores from different queries', () => {
    expect(() => decide(scores([1, 1]), scores([1]))).toThrow(/same queries/);
  });
});
