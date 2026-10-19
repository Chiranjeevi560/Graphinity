import { describe, expect, it } from 'vitest';
import { DUPLICATE_AT, fuse, RELATED_AT, RRF_K, shortlist, verdict, W_MEANING, W_WORDS } from '../src/precheck.ts';

describe('fusing meaning and words (spec §12.1)', () => {
  it('scores each list by reciprocal rank, meaning weighted 0.65 and words 0.35', () => {
    // "b" is second by meaning and first by words; "a" is first by meaning only.
    const b = W_MEANING / (RRF_K + 2) + W_WORDS / (RRF_K + 1);
    const a = W_MEANING / (RRF_K + 1);
    expect(b).toBeGreaterThan(a);
    expect(fuse(['a', 'b'], ['b'])).toEqual(['b', 'a']);
  });

  it('keeps things found by only one of them', () => {
    expect(fuse(['1'], ['2'])).toEqual(['1', '2']);
    expect(fuse([], ['5', '6'])).toEqual(['5', '6']);
    expect(fuse([], [])).toEqual([]);
  });
});

describe('the decision (spec §11.1)', () => {
  const now = new Date('2026-10-19T00:00:00Z');
  const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000);

  it('stops a duplicate only when it is the same in meaning and was answered recently', () => {
    expect(verdict([{ similarity: DUPLICATE_AT, lastAnsweredAt: daysAgo(10), everyWord: false }], now, true)).toBe('duplicate');
    expect(verdict([{ similarity: DUPLICATE_AT, lastAnsweredAt: daysAgo(181), everyWord: false }], now, true)).toBe('related');
    expect(verdict([{ similarity: 0.95, lastAnsweredAt: null, everyWord: false }], now, true)).toBe('related');
  });

  it('shows related questions from 0.72, and nothing below', () => {
    expect(verdict([{ similarity: RELATED_AT, lastAnsweredAt: null, everyWord: false }], now, true)).toBe('related');
    expect(verdict([{ similarity: RELATED_AT - 0.001, lastAnsweredAt: daysAgo(1), everyWord: false }], now, true)).toBe('clear');
    expect(verdict([], now, true)).toBe('clear');
  });

  it('shows a question holding every word typed so far, however far apart in meaning', () => {
    // A half-typed word or an exact code ("BOE-II") means little to the model.
    expect(verdict([{ similarity: 0.33, lastAnsweredAt: daysAgo(1), everyWord: true }], now, true)).toBe('related');
    expect(verdict([{ similarity: 0.33, lastAnsweredAt: daysAgo(1), everyWord: false }], now, true)).toBe('clear');
    // Words never make a duplicate: only meaning does.
    expect(verdict([{ similarity: null, lastAnsweredAt: daysAgo(1), everyWord: true }], now, true)).toBe('related');
  });

  it('never stops anyone on word matches alone', () => {
    expect(verdict([{ similarity: null, lastAnsweredAt: daysAgo(1), everyWord: false }], now, false)).toBe('related');
    expect(verdict([], now, false)).toBe('clear');
  });
});

describe('the few shown (spec §11.1)', () => {
  const now = new Date('2026-10-19T00:00:00Z');
  const c = (id: string, similarity: number | null, everyWord: boolean, answeredDaysAgo: number | null = null) =>
    ({ id, similarity, everyWord, lastAnsweredAt: answeredDaysAgo === null ? null : new Date(now.getTime() - answeredDaysAgo * 86_400_000) });

  it('puts a recent duplicate first, then every-word matches, then the rest in fused order', () => {
    const fused = [c('a', 0.8, false), c('b', 0.5, true), c('dup', DUPLICATE_AT, false, 3), c('d', 0.7, false), c('e', 0.4, true)];
    expect(shortlist(fused, now, 5).map(x => x.id)).toEqual(['dup', 'b', 'e', 'a', 'd']);
  });

  it('keeps an every-word match that fused order would cut', () => {
    const fused = [c('1', 0.8, false), c('2', 0.8, false), c('3', 0.8, false), c('typed', 0.3, true)];
    expect(shortlist(fused, now, 2).map(x => x.id)).toEqual(['typed', '1']);
  });

  it('treats a stale near-copy as an ordinary candidate', () => {
    expect(shortlist([c('x', 0.5, false), c('old', 0.95, false, 400)], now, 2).map(x => x.id)).toEqual(['x', 'old']);
  });
});
