// The joint text-image embedding engine (ADR 0037) on synthetic pairs: image and text features are two noisy views of
// one hidden meaning, so a trained model should find each text's own image far more often than chance.
import { describe, expect, it } from 'vitest';
import { seededRandom } from '../src/ml/linalg.ts';
import { embedImage, embedText, recallAt1, trainJointEmbedding } from '../src/ml/joint-embedding.ts';

function pairs(n: number, seed: number) {
  const random = seededRandom(seed);
  const mixImage = Array.from({ length: 24 * 6 }, () => random() - 0.5);
  const mixText = Array.from({ length: 32 * 6 }, () => random() - 0.5);
  return Array.from({ length: n }, () => {
    const meaning = Array.from({ length: 6 }, () => random() * 2 - 1);
    const view = (mix: number[], size: number) =>
      Array.from(
        { length: size },
        (_, i) => meaning.reduce((s, z, k) => s + z * (mix[i * 6 + k] ?? 0), 0) + (random() - 0.5) * 0.1,
      );
    return { image: view(mixImage, 24), text: view(mixText, 32) };
  });
}

describe('joint text-image embedding', () => {
  it('learns to find each text’s own image among many, on pairs it never trained on', () => {
    const train = pairs(600, 1);
    const held = pairs(100, 1).map((p, i) => pairs(700, 1)[600 + i] ?? p);
    const untrained = trainJointEmbedding(train, { epochs: 0 });
    const model = trainJointEmbedding(train, { epochs: 25 });
    // Chance is 1 in 100.
    expect(recallAt1(untrained, held)).toBeLessThan(0.1);
    expect(recallAt1(model, held)).toBeGreaterThan(0.3);
  });

  it('returns unit vectors in the shared space, and nothing for nothing', () => {
    const model = trainJointEmbedding(pairs(64, 2), { epochs: 2, dims: 8 });
    const [p] = pairs(1, 3);
    for (const v of [embedImage(model, p?.image ?? []), embedText(model, p?.text ?? [])]) {
      expect(v).toHaveLength(8);
      expect(Math.hypot(...v)).toBeCloseTo(1, 6);
    }
    expect(recallAt1(model, [])).toBe(0);
  });
});
