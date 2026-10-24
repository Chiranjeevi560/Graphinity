// One training run of spelling correction (ADR 0011), as a pure function of
// its input: split off the held-out posts, make test words from them, tune
// λ, μ and keep on one half, score the tuned model and the serving one on the
// other half, decide. Pure, so it is tested directly and runs unchanged on
// the training worker thread.
import { MIN_COUNT, decideSpelling, evaluateSpelling, splitDocuments, testWords, tune } from './spelling-gate.ts';
import type { SpellingDecision, SpellingScores } from './spelling-gate.ts';
import { deserializeSpelling, serializeSpelling, trainSpelling, type SpellingParams } from './spelling.ts';

export const SPELLING_ALGORITHM = 'symspell-bigram-channel';

export interface SpellingInput {
  questions: Array<{ id: string; title: string; body: string }>;
  answers: Array<{ questionId: string; body: string }>;
  /** The serving version, if one serves: the candidate mustn't fix fewer typos than it. */
  serving: { version: number; artifact: Uint8Array } | null;
  /** Seeds the injected typos; fixed, so a run can be repeated exactly. */
  seed?: number;
}

export interface SpellingResult {
  decision: SpellingDecision;
  params: SpellingParams & { seed: number };
  dataset: {
    trainingDocuments: number;
    heldOutDocuments: number;
    vocabulary: number;
    tuneWords: number;
    testWords: number;
  };
  /** Scores on the test half, which tuning never saw. */
  metrics: SpellingScores & { tuneRecall: number; trainMs: number };
  baseline: { kind: 'model' | 'none'; version: number | null; scores: SpellingScores | null };
  /** Only when promoted: a rejected model is never kept. */
  artifact: Uint8Array | null;
}

export function trainSpellingAndEvaluate(input: SpellingInput): SpellingResult {
  const seed = input.seed ?? 1;
  const { training, heldOut } = splitDocuments(input.questions, input.answers);
  const started = performance.now();
  // Typos go into words the model could know; the rest of the held-out words are the "leave alone" set.
  const vocabulary = new Set(trainSpelling(training, { lambda: 0, mu: 0, minCount: MIN_COUNT, keep: 0 }).words);
  const words = testWords(heldOut, vocabulary, seed);
  const tuned = tune(training, words.tune);
  const model = trainSpelling(training, tuned.params);
  const trainMs = Math.round(performance.now() - started);

  const scores = evaluateSpelling(model, words.test);
  const servingModel = input.serving ? deserializeSpelling(Buffer.from(input.serving.artifact)) : null;
  const servingScores = servingModel ? evaluateSpelling(servingModel, words.test) : null;
  const decision = decideSpelling(scores, servingScores);
  return {
    decision,
    params: { ...tuned.params, seed },
    dataset: {
      trainingDocuments: training.length,
      heldOutDocuments: heldOut.length,
      vocabulary: model.words.length,
      tuneWords: words.tune.length,
      testWords: words.test.length,
    },
    metrics: { ...scores, tuneRecall: tuned.scores.recall, trainMs },
    baseline: {
      kind: servingModel ? 'model' : 'none',
      version: input.serving?.version ?? null,
      scores: servingScores,
    },
    artifact: decision.promote ? new Uint8Array(serializeSpelling(model)) : null,
  };
}
