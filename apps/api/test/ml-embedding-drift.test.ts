import { describe, expect, it } from 'vitest';
import { centroidOf, embeddingSignals } from '../src/ml/embedding-drift.ts';
import { embedText, trainTextEmbedding } from '../src/ml/text-embedding.ts';

const model = trainTextEmbedding(
  [
    'customs duty on a watch at the airport',
    'import tax on a phone at the airport',
    'customs duty on a phone at the border',
    'import tax on a watch at the border',
  ],
  { dims: 6, minCount: 1 },
);

describe('embedding signals', () => {
  it('measure the share of known words, case and punctuation aside', () => {
    const s = embeddingSignals(
      model,
      ['Customs duty, airport!', 'customs duty on quantum gravity', ''],
      centroidOf(model, ['customs duty']),
    );
    // The empty text gives no signal at all.
    expect(s.coverage).toEqual([1, 0.6]);
    expect(s.centroid_similarity).toHaveLength(2);
  });

  it('give each text its cosine with the centre', () => {
    const centre = centroidOf(model, ['customs duty on a watch']);
    const [similarity] = embeddingSignals(model, ['customs duty on a watch'], centre).centroid_similarity;
    expect(similarity).toBeCloseTo(1, 9);
    const v = embedText(model, 'import tax on a phone');
    const expected = Array.from(v).reduce((sum, x, i) => sum + x * (centre[i] ?? 0), 0);
    expect(embeddingSignals(model, ['import tax on a phone'], centre).centroid_similarity[0]).toBeCloseTo(expected, 12);
  });

  it('centre is the unit mean of the embeddings, and zero for no words', () => {
    const c = centroidOf(model, ['customs duty', 'import tax']);
    expect(Math.hypot(...c)).toBeCloseTo(1, 9);
    expect(centroidOf(model, ['', '!!'])).toEqual(new Array<number>(6).fill(0));
  });
});
