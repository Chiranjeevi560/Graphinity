import { describe, expect, it } from 'vitest';
import { confidence, decayed, SIGNALS } from '../src/personalization/signals.ts';
import { ALL_SOURCES, explain, REASONS } from '../src/recommendations/feed.ts';

describe('the signal catalogue', () => {
  it('holds 31 distinct signals, each with a usable decay and prior', () => {
    expect(SIGNALS).toHaveLength(31);
    expect(new Set(SIGNALS.map(s => s.name)).size).toBe(31);
    for (const s of SIGNALS) {
      expect(s.halfLifeDays).toBeGreaterThan(0);
      expect(s.prior).toBeGreaterThan(0);
      expect(s.sql).toMatch(/\$1/);
    }
  });

  it('halves evidence at the half-life and treats future times as now', () => {
    expect(decayed(30, 30)).toBeCloseTo(0.5);
    expect(decayed(60, 30)).toBeCloseTo(0.25);
    expect(decayed(-5, 30)).toBe(1);
  });

  it('has no confidence without evidence, one half at the prior, and never certainty', () => {
    expect(confidence(0, 2)).toBe(0);
    expect(confidence(2, 2)).toBe(0.5);
    expect(confidence(1e9, 2)).toBeLessThan(1);
    expect(confidence(4, 2)).toBeGreaterThan(confidence(1, 2));
  });
});

describe('the explanation trace', () => {
  it('names real signals, a tier, and no commercial input, for every source', () => {
    const known = new Set(SIGNALS.map(s => s.name));
    for (const source of ALL_SOURCES) {
      const t = explain(source, 0.0123456789);
      expect(REASONS[source]).toBeTruthy();
      expect(t.tier).toBeGreaterThanOrEqual(1);
      expect(t.commercialInputs).toBe(0);
      expect(t.score).toBe(0.012346);
      for (const s of t.signals) expect(known.has(s)).toBe(true);
    }
  });

  it('says personal sources need their choice, and impersonal ones need none', () => {
    expect(explain('search', 1).consent).toBe('search_history');
    expect(explain('reading', 1).consent).toBe('reading_history');
    expect(explain('recent', 1)).toMatchObject({ consent: null, signals: [] });
  });
});
