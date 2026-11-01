import { describe, expect, it } from 'vitest';
import { diversify, NEXT_TOPIC_WEIGHT, preRank } from '../src/search/cascade.ts';
import type { Found } from '../src/search/engine.ts';

const found = (id: string, field = 'a'): Found => ({
  id,
  title: id,
  field,
  fieldName: field,
  answerCount: 0,
  lastAnsweredAt: null,
  similarity: null,
  wordRank: 1,
  meaningRank: null,
  everyWord: true,
});

describe('preRank', () => {
  const list = Array.from({ length: 150 }, (_, i) => found(String(i), i === 3 ? 'next' : 'a'));

  it('keeps the fused order and the limit when the session says nothing', () => {
    const out = preRank(list, new Map());
    expect(out).toHaveLength(100);
    expect(out[0]?.id).toBe('0');
    expect(out[99]?.id).toBe('99');
  });

  it('lifts where the session is heading, but a hint cannot outrun far better results by much', () => {
    const out = preRank(list, new Map([['next', 1]]));
    expect(out[0]?.id).toBe('3');
    const small = preRank(list, new Map([['next', 0.1]]));
    expect(small.findIndex(f => f.id === '3')).toBeGreaterThan(0);
    expect(NEXT_TOPIC_WEIGHT).toBeLessThan(1 / 60);
  });
});

describe('diversify', () => {
  it('drops a near-copy for something different', () => {
    const list = [found('a'), found('copy'), found('other')];
    const vectors = new Map([
      ['a', [1, 0]],
      ['copy', [1, 0]],
      ['other', [0, 1]],
    ]);
    expect(diversify(list, vectors, 2).map(f => f.id)).toEqual(['a', 'other']);
  });

  it('still fills the page when what is left only repeats, and never hides a result without a vector', () => {
    const list = [found('a'), found('copy'), found('novector')];
    const vectors = new Map([
      ['a', [1, 0]],
      ['copy', [1, 0]],
    ]);
    const out = diversify(list, vectors, 3).map(f => f.id);
    expect(out).toHaveLength(3);
    expect(new Set(out)).toEqual(new Set(['a', 'copy', 'novector']));
    expect(out.indexOf('novector')).toBeLessThan(out.indexOf('copy'));
  });
});
