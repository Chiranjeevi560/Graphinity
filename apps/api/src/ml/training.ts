// The daily training jobs for Graphinity's own models (ADR 0010, 0011): load
// what may be learned from, skip when there's nothing new or too little,
// train and evaluate on a worker thread, and record the result in the
// registry. A model that wins its gate is promoted at once; one that doesn't
// is recorded with its scores and why, so every run is accountable.
import { Worker } from 'node:worker_threads';
import type { Database } from '../db.ts';
import { loadCorpus, type Corpus } from './corpus.ts';
import { latestFingerprint, loadServing, recordPromoted, recordRejected, type ModelRecord } from './registry.ts';
import { ALGORITHM, type TrainingResult, type WorkerInput } from './train-embedding.ts';
import { SPELLING_ALGORITHM, type SpellingInput, type SpellingResult } from './train-spelling.ts';

export const TEXT_EMBEDDING = 'text-embedding';
export const SPELLING = 'spelling';

/**
 * Below this many documents a run isn't attempted: with one in five
 * questions held out, fewer than about 200 can't yield the 30 evaluable
 * queries (or the 100 test typos) a gate needs, so the CPU would be spent
 * for a certain "no".
 */
export const MIN_DOCUMENTS = 200;

export type TrainingOutcome<R = TrainingResult> =
  | { status: 'skipped'; reason: string }
  | { status: 'rejected'; version: number; reason: string; result: R }
  | { status: 'promoted'; version: number; reason: string; result: R };

export type WorkerJob = { job: 'text-embedding'; input: WorkerInput } | { job: 'spelling'; input: SpellingInput };

/** Runs a job on a worker thread; the main thread stays free for requests. */
function onWorker<R>(job: WorkerJob): Promise<R> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./training-worker.ts', import.meta.url), { workerData: job });
    worker.once('message', (m: { ok: true; result: R } | { ok: false; error: string }) => {
      if (m.ok) resolve(m.result);
      else reject(new Error(m.error));
    });
    worker.once('error', reject);
    worker.once('exit', code => {
      if (code !== 0) reject(new Error(`training worker exited with code ${String(code)}`));
    });
  });
}

export const runOnWorker = (input: WorkerInput) => onWorker<TrainingResult>({ job: 'text-embedding', input });
export const runSpellingOnWorker = (input: SpellingInput) => onWorker<SpellingResult>({ job: 'spelling', input });

interface Gated {
  decision: { promote: boolean; reason: string };
  artifact: Uint8Array | null;
}

/** What every job shares: the two reasons to skip, the run, and its record. */
async function trainJob<R extends Gated>(
  db: Pick<Database, 'asSystem'>,
  name: string,
  minDocuments: number,
  train: (corpus: Corpus, serving: { version: number; artifact: Uint8Array } | null) => Promise<R>,
  describe: (result: R) => Omit<ModelRecord, 'name' | 'reason' | 'dataset'> & { dataset: Record<string, unknown> },
): Promise<TrainingOutcome<R>> {
  const corpus = await loadCorpus(db);
  const documents = corpus.questions.length + corpus.answers.length;
  if (documents < minDocuments)
    return { status: 'skipped', reason: `${String(documents)} consented documents; ${String(minDocuments)} needed` };
  if ((await latestFingerprint(db, name)) === corpus.fingerprint)
    return { status: 'skipped', reason: 'nothing new since the last run' };

  const serving = await loadServing(db, name);
  const result = await train(
    corpus,
    serving ? { version: serving.version, artifact: new Uint8Array(serving.artifact) } : null,
  );
  const described = describe(result);
  const record = {
    ...described,
    name,
    dataset: { ...described.dataset, fingerprint: corpus.fingerprint },
    reason: result.decision.reason,
  };
  if (result.decision.promote && result.artifact) {
    const version = await recordPromoted(db, record, Buffer.from(result.artifact));
    return { status: 'promoted', version, reason: result.decision.reason, result };
  }
  const version = await recordRejected(db, record);
  return { status: 'rejected', version, reason: result.decision.reason, result };
}

export function trainTextEmbeddingJob(
  db: Pick<Database, 'asSystem'>,
  options: { run?: (input: WorkerInput) => Promise<TrainingResult>; minDocuments?: number } = {},
): Promise<TrainingOutcome> {
  return trainJob(
    db,
    TEXT_EMBEDDING,
    options.minDocuments ?? MIN_DOCUMENTS,
    (corpus, serving) =>
      (options.run ?? runOnWorker)({ questions: corpus.questions, answers: corpus.answers, serving }),
    result => ({
      algorithm: ALGORITHM,
      params: result.params,
      dataset: result.dataset,
      metrics: { ...result.metrics, difference: result.decision.difference },
      baseline: result.baseline,
    }),
  );
}

export function trainSpellingJob(
  db: Pick<Database, 'asSystem'>,
  options: { run?: (input: SpellingInput) => Promise<SpellingResult>; minDocuments?: number } = {},
): Promise<TrainingOutcome<SpellingResult>> {
  return trainJob(
    db,
    SPELLING,
    options.minDocuments ?? MIN_DOCUMENTS,
    (corpus, serving) =>
      (options.run ?? runSpellingOnWorker)({ questions: corpus.questions, answers: corpus.answers, serving }),
    result => ({
      algorithm: SPELLING_ALGORITHM,
      params: { ...result.params },
      dataset: result.dataset,
      metrics: { ...result.metrics },
      baseline: result.baseline,
    }),
  );
}
