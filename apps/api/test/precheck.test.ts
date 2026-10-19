import { describe, expect, it } from 'vitest';
import { DUPLICATE_AT, fuse, RELATED_AT, RRF_K, verdict, W_MEANING, W_WORDS } from '../src/precheck.ts';

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
    expect(verdict([{ similarity: DUPLICATE_AT, lastAnsweredAt: daysAgo(10) }], now, true)).toBe('duplicate');
    expect(verdict([{ similarity: DUPLICATE_AT, lastAnsweredAt: daysAgo(181) }], now, true)).toBe('related');
    expect(verdict([{ similarity: 0.95, lastAnsweredAt: null }], now, true)).toBe('related');
  });

  it('shows related questions from 0.72, and nothing below', () => {
    expect(verdict([{ similarity: RELATED_AT, lastAnsweredAt: null }], now, true)).toBe('related');
    expect(verdict([{ similarity: RELATED_AT - 0.001, lastAnsweredAt: daysAgo(1) }], now, true)).toBe('clear');
    expect(verdict([], now, true)).toBe('clear');
  });

  it('never stops anyone on word matches alone', () => {
    expect(verdict([{ similarity: null, lastAnsweredAt: daysAgo(1) }], now, false)).toBe('related');
    expect(verdict([], now, false)).toBe('clear');
  });
});
