import { describe, expect, it } from 'vitest';
import { evaluateRanking } from '../src/ranking-evaluation.ts';
import { rankRecommendations } from '../src/recommendation-ranking.ts';

describe('knowledge recommendation ranking', () => {
  it('fuses active source ranks without hand-tuned feature weights and explains the strongest source', () => {
    const ranked = rankRecommendations(
      [
        { id: 'joint', ranks: { field: 2, search: 1, reading: null, recent: 3 } },
        { id: 'search', ranks: { field: null, search: 2, reading: null, recent: 1 } },
        { id: 'topic', ranks: { field: 1, search: null, reading: null, recent: 2 } },
        { id: 'recent', ranks: { field: null, search: null, reading: null, recent: 4 } },
      ],
      4,
    );
    expect(ranked[0]?.item.id).toBe('joint');
    expect(ranked.find(candidate => candidate.item.id === 'joint')?.reason).toBe(
      'Related to your recent Graphinity searches',
    );
    expect(ranked.find(candidate => candidate.item.id === 'topic')?.reason).toBe('In one of your selected topics');
    expect(ranked[0]?.score).toBeCloseTo(1 / 62 + 1 / 61 + 1 / 63);
  });

  it('uses the offline ranking evaluator on recommendations with explicit relevance judgments', () => {
    const candidates = [
      { id: 'useful', ranks: { field: 2, search: 1, reading: 1, recent: 3 }, relevance: 3 },
      { id: 'irrelevant', ranks: { field: null, search: null, reading: null, recent: 1 }, relevance: 0 },
      { id: 'related', ranks: { field: 1, search: null, reading: null, recent: 2 }, relevance: 2 },
    ];
    const ranked = rankRecommendations(candidates, 3);
    const metrics = evaluateRanking(
      [
        {
          candidates: ranked.map(({ item, score }) => ({ id: item.id, score, relevance: item.relevance })),
        },
      ],
      3,
    );
    expect(ranked[0]?.item.id).toBe('useful');
    expect(metrics.ndcgAtK).toBeGreaterThan(0.95);
    expect(metrics.meanReciprocalRank).toBe(1);
    expect(metrics.recallAtK).toBe(1);
  });

  it('rejects invalid source ranks and result limits', () => {
    expect(() =>
      rankRecommendations([{ id: 'bad', ranks: { field: 0, search: null, reading: null, recent: 1 } }], 1),
    ).toThrow(RangeError);
    expect(() => rankRecommendations([], -1)).toThrow(RangeError);
  });
});
