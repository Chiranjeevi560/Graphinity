// The spelling training run itself, as the worker thread runs it, on the main
// thread (the logic is a pure function of its input).
import { describe, expect, it } from 'vitest';
import { isHeldOut } from '../src/ml/embedding-gate.ts';
import { seededRandom } from '../src/ml/linalg.ts';
import { deserializeSpelling, speller } from '../src/ml/spelling.ts';
import { trainSpellingAndEvaluate, type SpellingInput } from '../src/ml/train-spelling.ts';

/** Made-up words from syllables, used at Zipf-like frequencies, plus a few names written once. */
function corpus(n: number): SpellingInput['questions'] {
  const random = seededRandom(7);
  const syllables = ['ka', 'ro', 'mi', 'sun', 'tel', 'dar', 'vo', 'pen', 'lis', 'gor', 'ane', 'qui', 'bra', 'tos'];
  const lexicon = new Set<string>();
  while (lexicon.size < 300) {
    let w = '';
    for (let i = 0, k = 2 + Math.floor(random() * 2); i < k; i++)
      w += syllables[Math.floor(random() * syllables.length)] ?? '';
    lexicon.add(w);
  }
  const words = [...lexicon];
  const pick = (k: number) =>
    Array.from({ length: k }, () => words[Math.floor(Math.pow(random(), 1.5) * words.length)] ?? '').join(' ');
  // A name in letters only, different for every question: "zephab", "zephac", …
  const name = (i: number) => `zeph${String.fromCharCode(97 + (Math.floor(i / 26) % 26), 97 + (i % 26))}`;
  return Array.from({ length: n }, (_, i) => ({
    id: String(i + 1),
    title: `${pick(8)} ${name(i)}`,
    body: pick(20),
  }));
}

describe('one spelling training run', () => {
  it('never learns a word from a held-out question or its answers', () => {
    const questions = corpus(60).map(q => ({
      ...q,
      body: `${q.body} ${isHeldOut(q.id) ? 'heldword heldword' : 'trainword trainword'}`,
    }));
    const answers = questions.map(q => ({ questionId: q.id, body: isHeldOut(q.id) ? 'answerheld answerheld' : 'ok' }));
    const heldOut = questions.filter(q => isHeldOut(q.id)).length;
    const result = trainSpellingAndEvaluate({ questions, answers, serving: null });
    expect(heldOut).toBeGreaterThan(0);
    expect(result.dataset).toMatchObject({
      trainingDocuments: 2 * (questions.length - heldOut),
      heldOutDocuments: 2 * heldOut,
    });
    const words = deserializeSpelling(Buffer.from(result.artifact ?? new Uint8Array())).words;
    expect(words).toContain('trainword');
    expect(words).not.toContain('heldword');
    expect(words).not.toContain('answerheld');
  });

  it('keeps nothing when there is too little to judge it by', () => {
    const result = trainSpellingAndEvaluate({ questions: corpus(8), answers: [], serving: null });
    expect(result.decision).toMatchObject({ promote: false, reason: /test typos/ });
    expect(result.artifact).toBeNull();
    expect(result.baseline).toEqual({ kind: 'none', version: null, scores: null });
  });

  it('is promoted when it learns to fix typos, leaves names alone, and serves what it was scored as', () => {
    const questions = corpus(400);
    const result = trainSpellingAndEvaluate({ questions, answers: [], serving: null });
    expect(result.metrics.typos).toBeGreaterThanOrEqual(100);
    expect(result.metrics.newWords).toBeGreaterThan(0);
    expect(result.metrics.precisionLower).toBeGreaterThanOrEqual(0.8);
    expect(result.decision.promote).toBe(true);
    expect(result.params.seed).toBe(1);

    const model = deserializeSpelling(Buffer.from(result.artifact ?? new Uint8Array()));
    const { seed: _seed, ...params } = result.params;
    expect(model.params).toEqual(params);
    // Names written once are never learned as words, so they're never "corrected" into one.
    expect(model.words.some(w => w.startsWith('zeph'))).toBe(false);
    const known = model.words.find(w => w.length >= 6) ?? '';
    expect(speller(model).correct(`${known.slice(0, 2)}${known.slice(3)}`, null)).toBe(known);

    // Against itself as the serving version: the same test words, the same scores.
    const again = trainSpellingAndEvaluate({
      questions,
      answers: [],
      serving: { version: 4, artifact: result.artifact ?? new Uint8Array() },
    });
    expect(again.baseline).toMatchObject({ kind: 'model', version: 4, scores: { recall: result.metrics.recall } });
    expect(again.decision.promote).toBe(true);
  });
});
