import { describe, expect, it } from 'vitest';
import { classifyCommercialIntent, INTENT_DIMENSIONS } from '../src/commercial-intent.ts';

describe('public-page commercial intent baseline', () => {
  it('returns all 14 dimensions with deterministic bounded confidence and explanations', () => {
    const input = {
      title: 'How much customs duty did you pay to import a used watch?',
      consensusSummary: 'The typical import duty varies by country.',
      tags: ['watch', 'import'],
      country: 'IN',
      pageConfidence: 0.8,
    };
    const result = classifyCommercialIntent(input);
    expect(Object.keys(result.dimensions)).toEqual(INTENT_DIMENSIONS);
    expect(result).toEqual(classifyCommercialIntent(input));
    expect(result.version).toBe('lexical-v1');
    expect(result.dimensions.import.confidence).toBeGreaterThan(0);
    expect(result.dimensions.import.matchedSignals).toContain('import');
    expect(result.dimensions.purchase.confidence).toBe(0);
    for (const dimension of INTENT_DIMENSIONS) {
      const score = result.dimensions[dimension];
      expect(score.confidence).toBeGreaterThanOrEqual(0);
      expect(score.confidence).toBeLessThanOrEqual(1);
      expect(score.explanation.length).toBeGreaterThan(0);
    }
  });

  it('uses only the supplied public page evidence and ignores commercial payout metadata', () => {
    const page = { title: 'Which developer tool should our team deploy?' };
    const baseline = classifyCommercialIntent(page);
    const withUnrelatedMetadata = classifyCommercialIntent({
      ...page,
      affiliatePayout: 1_000_000,
      userId: 'must-not-be-read',
      purchaseHistory: ['sensitive item'],
    } as typeof page);
    expect(withUnrelatedMetadata).toEqual(baseline);
    expect(baseline.dimensions.developer_tooling.confidence).toBeGreaterThan(0);
  });

  it('normalizes full-width text and remains zero for unrelated content', () => {
    const fullWidth = classifyCommercialIntent({ title: 'Ｈｏｗ ｄｏ Ｉ ｂｕｙ ａ ｐｒｏｄｕｃｔ？' });
    expect(fullWidth.dimensions.purchase.confidence).toBeGreaterThan(0);
    const blank = classifyCommercialIntent({ title: 'How did the experiment behave?' });
    expect(Object.values(blank.dimensions).every(score => score.confidence === 0)).toBe(true);
  });

  it('clamps malformed page confidence safely', () => {
    const low = classifyCommercialIntent({ title: 'buy price', pageConfidence: Number.NaN });
    const high = classifyCommercialIntent({ title: 'buy price', pageConfidence: 5 });
    expect(low.dimensions.purchase.confidence).toBeGreaterThan(0);
    expect(high.dimensions.purchase.confidence).toBeLessThanOrEqual(1);
  });
});
