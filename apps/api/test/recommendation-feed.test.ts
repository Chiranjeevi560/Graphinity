import { describe, expect, it } from 'vitest';
import { evaluateRanking } from '../src/ranking-evaluation.ts';
import { fuseSources, interleaveLists, REASONS } from '../src/recommendations/feed.ts';

describe('fusing recommendation sources (feed-rrf-v3)', () => {
  it('fuses each source’s rank with no hand-picked weights, and explains by the strongest', () => {
    const fused = fuseSources({
      search: ['joint', 'searched'],
      field: ['topic', 'joint'],
      recent: ['searched', 'topic', 'joint', 'recent'],
    });
    expect(fused[0]).toMatchObject({ id: 'joint', source: 'search' });
    expect(fused[0]?.score).toBeCloseTo(1 / 61 + 1 / 62 + 1 / 63, 12);
    expect(fused.find(f => f.id === 'topic')?.source).toBe('field');
    expect(fused.at(-1)).toMatchObject({ id: 'recent', source: 'recent' });
    expect(REASONS.co_answer).toBe('Answered by people who answered one you opened');
  });

  it('fuses only the sources it is given: one tier at a time', () => {
    const ranked = { search: ['a'], field: ['b', 'a'] };
    expect(fuseSources(ranked, ['field']).map(f => f.id)).toEqual(['b', 'a']);
    expect(fuseSources(ranked, ['search']).map(f => f.id)).toEqual(['a']);
  });

  it('breaks ties by the newer question, and is empty with nothing to fuse', () => {
    expect(fuseSources({ search: ['1'], reading: ['2'] }).map(f => f.id)).toEqual(['2', '1']);
    expect(fuseSources({})).toEqual([]);
  });

  it('merges per-seed lists round robin, each result once, bounded', () => {
    expect(interleaveLists([['a', 'b', 'c'], ['b', 'd'], ['e']])).toEqual(['a', 'b', 'e', 'd', 'c']);
    expect(interleaveLists([['a', 'b', 'c'], ['d']], 2)).toEqual(['a', 'd']);
    expect(interleaveLists([['a'], ['b'], ['c']], 2)).toEqual(['a', 'b']);
    expect(interleaveLists([])).toEqual([]);
  });

  it('ranks judged-useful results first, as the offline evaluator measures', () => {
    const relevance = new Map([
      ['useful', 3],
      ['related', 2],
      ['irrelevant', 0],
    ]);
    const fused = fuseSources({
      search: ['useful'],
      reading: ['useful', 'related'],
      recent: ['irrelevant', 'related'],
    });
    const metrics = evaluateRanking(
      [{ candidates: fused.map(f => ({ id: f.id, score: f.score, relevance: relevance.get(f.id) ?? 0 })) }],
      3,
    );
    expect(fused[0]?.id).toBe('useful');
    expect(metrics.meanReciprocalRank).toBe(1);
    expect(metrics.ndcgAtK).toBeGreaterThan(0.95);
  });
});
