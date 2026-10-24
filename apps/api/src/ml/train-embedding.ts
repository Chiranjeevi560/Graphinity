// One training run of the text embedding, start to finish, as a pure
// function of its input: split, train, score the candidate and the serving
// model (or word matching) on the same held-out questions, decide. Pure, so
// it is tested directly and runs unchanged on a worker thread.
import { bm25Scorer, decide, evaluateRetrieval, fusedScorer, isHeldOut, type GateDecision } from './embedding-gate.ts';
import {
  ALGORITHM,
  DEFAULTS,
  deserializeModel,
  serializeModel,
  trainTextEmbedding,
  type TrainingOptions,
} from './text-embedding.ts';

export interface WorkerInput {
  questions: Array<{ id: string; title: string; body: string }>;
  answers: Array<{ questionId: string; body: string }>;
  /** The serving model's weights, if one serves: the bar to clear. Otherwise word matching is. */
  serving: { version: number; artifact: Uint8Array } | null;
  options?: TrainingOptions;
}

export interface TrainingResult {
  decision: GateDecision;
  params: Required<TrainingOptions>;
  dataset: { trainingDocuments: number; heldOutQuestions: number; vocabulary: number };
  metrics: { mrr: number; recallAt10: number; queries: number; trainMs: number };
  baseline: { kind: 'model' | 'bm25'; version: number | null; mrr: number; recallAt10: number };
  /** Only when promoted: a rejected model's weights are never kept. */
  artifact: Uint8Array | null;
}

export function trainAndEvaluate(input: WorkerInput): TrainingResult {
  const params = { ...DEFAULTS, ...input.options };
  const heldOut = input.questions.filter(q => isHeldOut(q.id));
  const heldOutIds = new Set(heldOut.map(q => q.id));
  // Nothing of a held-out question reaches training, its answers included.
  const documents = [
    ...input.questions.filter(q => !heldOutIds.has(q.id)).map(q => (q.body ? `${q.title}\n${q.body}` : q.title)),
    ...input.answers.filter(a => !heldOutIds.has(a.questionId)).map(a => a.body),
  ];
  const started = performance.now();
  const model = trainTextEmbedding(documents, params);
  const trainMs = Math.round(performance.now() - started);

  // Judged as it would serve: fused with word matching, against what serves now
  // (fused with the serving model, or words alone when none serves).
  const candidate = evaluateRetrieval(heldOut, fusedScorer(model, heldOut));
  const servingModel = input.serving ? deserializeModel(Buffer.from(input.serving.artifact)) : null;
  const baselineScores = evaluateRetrieval(
    heldOut,
    servingModel ? fusedScorer(servingModel, heldOut) : bm25Scorer(heldOut),
  );
  const decision = decide(candidate, baselineScores, params.seed);
  return {
    decision,
    params,
    dataset: { trainingDocuments: documents.length, heldOutQuestions: heldOut.length, vocabulary: model.vocab.length },
    metrics: { mrr: candidate.mrr, recallAt10: candidate.recallAt10, queries: candidate.queries, trainMs },
    baseline: {
      kind: servingModel ? 'model' : 'bm25',
      version: input.serving?.version ?? null,
      mrr: baselineScores.mrr,
      recallAt10: baselineScores.recallAt10,
    },
    artifact: decision.promote ? new Uint8Array(serializeModel(model)) : null,
  };
}

export { ALGORITHM };
