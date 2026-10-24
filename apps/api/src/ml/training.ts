// The daily training job for Graphinity's own text embedding (ADR 0010):
// load what may be learned from, skip when there's nothing new or too little,
// train and evaluate on a worker thread, and record the result in the
// registry. A model that wins its gate is promoted at once; one that doesn't
// is recorded with its scores and why, so every run is accountable.
import { Worker } from 'node:worker_threads';
import type { Database } from '../db.ts';
import { loadCorpus } from './corpus.ts';
import { latestFingerprint, loadServing, recordPromoted, recordRejected } from './registry.ts';
import { ALGORITHM, type TrainingResult, type WorkerInput } from './train-embedding.ts';

export const TEXT_EMBEDDING = 'text-embedding';

/**
 * Below this many documents a run isn't attempted: with one in five
 * questions held out, fewer than about 200 can't yield the 30 evaluable
 * queries the gate needs, so the CPU would be spent for a certain "no".
 */
export const MIN_DOCUMENTS = 200;

export type TrainingOutcome =
  | { status: 'skipped'; reason: string }
  | { status: 'rejected'; version: number; reason: string; result: TrainingResult }
  | { status: 'promoted'; version: number; reason: string; result: TrainingResult };

/** Runs `input` on a worker thread; the main thread stays free for requests. */
export function runOnWorker(input: WorkerInput): Promise<TrainingResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./training-worker.ts', import.meta.url), { workerData: input });
    worker.once('message', (m: { ok: true; result: TrainingResult } | { ok: false; error: string }) => {
      if (m.ok) resolve(m.result);
      else reject(new Error(m.error));
    });
    worker.once('error', reject);
    worker.once('exit', code => {
      if (code !== 0) reject(new Error(`training worker exited with code ${String(code)}`));
    });
  });
}

export async function trainTextEmbeddingJob(
  db: Pick<Database, 'asSystem'>,
  options: { run?: (input: WorkerInput) => Promise<TrainingResult>; minDocuments?: number } = {},
): Promise<TrainingOutcome> {
  const corpus = await loadCorpus(db);
  const documents = corpus.questions.length + corpus.answers.length;
  if (documents < (options.minDocuments ?? MIN_DOCUMENTS))
    return {
      status: 'skipped',
      reason: `${String(documents)} consented documents; ${String(options.minDocuments ?? MIN_DOCUMENTS)} needed`,
    };
  if ((await latestFingerprint(db, TEXT_EMBEDDING)) === corpus.fingerprint)
    return { status: 'skipped', reason: 'nothing new since the last run' };

  const serving = await loadServing(db, TEXT_EMBEDDING);
  const result = await (options.run ?? runOnWorker)({
    questions: corpus.questions,
    answers: corpus.answers,
    serving: serving ? { version: serving.version, artifact: new Uint8Array(serving.artifact) } : null,
  });
  const record = {
    name: TEXT_EMBEDDING,
    algorithm: ALGORITHM,
    params: result.params,
    dataset: { ...result.dataset, fingerprint: corpus.fingerprint },
    metrics: { ...result.metrics, difference: result.decision.difference },
    baseline: result.baseline,
    reason: result.decision.reason,
  };
  if (result.decision.promote && result.artifact) {
    const version = await recordPromoted(db, record, Buffer.from(result.artifact));
    return { status: 'promoted', version, reason: result.decision.reason, result };
  }
  const version = await recordRejected(db, record);
  return { status: 'rejected', version, reason: result.decision.reason, result };
}
