// The daily training jobs for Graphinity's own models (ADR 0010, 0011): load
// what may be learned from, skip when there's nothing new or too little,
// train and evaluate on a worker thread, and record the result in the
// registry. A model that wins its gate is promoted at once; one that doesn't
// is recorded with its scores and why, so every run is accountable.
import { Worker } from 'node:worker_threads';
import type { Database } from '../db.ts';
import { loadCorpus } from './corpus.ts';
import {
  latestFingerprint,
  loadServing,
  recordCandidate,
  recordPromoted,
  recordRejected,
  type ModelRecord,
} from './registry.ts';
import { loadSearchTraining } from '../search/ranker-data.ts';
import { SEARCH_RANKER } from '../search/rankers.ts';
import { SEARCH_RANKER_ALGORITHM, type SearchRankerInput, type SearchRankerResult } from './train-search-ranker.ts';
import { ALGORITHM, type TrainingResult, type WorkerInput } from './train-embedding.ts';
import { SPELLING_ALGORITHM, type SpellingInput, type SpellingResult } from './train-spelling.ts';
import { loadRoutingExamples } from './routing-data.ts';
import { lastRejectedAt } from './registry.ts';
import { ROUTING_ALGORITHM, type RoutingInput, type RoutingResult } from './train-routing.ts';

export const TEXT_EMBEDDING = 'text-embedding';
export const SPELLING = 'spelling';
export const ROUTING = 'routing';
/** Settled exploit routes needed before a routing run is attempted. */
export const MIN_ROUTES = 200;

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
  | { status: 'promoted'; version: number; reason: string; result: R }
  | { status: 'candidate'; version: number; reason: string; result: R };

/** Recorded searches needed before a search-ranker run is attempted. */
export const MIN_SEARCHES = 1000;

export type WorkerJob =
  | { job: 'text-embedding'; input: WorkerInput }
  | { job: 'spelling'; input: SpellingInput }
  | { job: 'routing'; input: RoutingInput }
  | { job: 'search-ranker'; input: SearchRankerInput };

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
export const runRoutingOnWorker = (input: RoutingInput) => onWorker<RoutingResult>({ job: 'routing', input });
export const runSearchRankerOnWorker = (input: SearchRankerInput) =>
  onWorker<SearchRankerResult>({ job: 'search-ranker', input });

interface Gated {
  decision: { promote: boolean; reason: string };
  artifact: Uint8Array | null;
}

/** What every job shares: the two reasons to skip, the run, and its record. */
async function trainJob<D extends { size: number; fingerprint: string }, R extends Gated>(
  db: Pick<Database, 'asSystem'>,
  name: string,
  minimum: { count: number; unit: string },
  load: () => Promise<D>,
  train: (data: D, serving: { version: number; artifact: Uint8Array } | null) => Promise<R>,
  describe: (result: R) => Omit<ModelRecord, 'name' | 'reason' | 'dataset'> & { dataset: Record<string, unknown> },
  /** What passing the offline gate makes it: the serving version, or a candidate for online comparison. */
  onPass: 'production' | 'candidate' = 'production',
): Promise<TrainingOutcome<R>> {
  const data = await load();
  if (data.size < minimum.count)
    return {
      status: 'skipped',
      reason: `${String(data.size)} ${minimum.unit}; ${String(minimum.count)} needed`,
    };
  if ((await latestFingerprint(db, name)) === data.fingerprint)
    return { status: 'skipped', reason: 'nothing new since the last run' };

  const serving = await loadServing(db, name);
  const result = await train(
    data,
    serving ? { version: serving.version, artifact: new Uint8Array(serving.artifact) } : null,
  );
  const described = describe(result);
  const record = {
    ...described,
    name,
    dataset: { ...described.dataset, fingerprint: data.fingerprint },
    reason: result.decision.reason,
  };
  if (result.decision.promote && result.artifact) {
    if (onPass === 'candidate') {
      const version = await recordCandidate(db, record, Buffer.from(result.artifact));
      return { status: 'candidate', version, reason: result.decision.reason, result };
    }
    const version = await recordPromoted(db, record, Buffer.from(result.artifact));
    return { status: 'promoted', version, reason: result.decision.reason, result };
  }
  const version = await recordRejected(db, record);
  return { status: 'rejected', version, reason: result.decision.reason, result };
}

/** Consented posts, sized as documents. */
const corpusOf = (db: Pick<Database, 'asSystem'>) => async () => {
  const corpus = await loadCorpus(db);
  return { ...corpus, size: corpus.questions.length + corpus.answers.length };
};

export function trainTextEmbeddingJob(
  db: Pick<Database, 'asSystem'>,
  options: { run?: (input: WorkerInput) => Promise<TrainingResult>; minDocuments?: number } = {},
): Promise<TrainingOutcome> {
  return trainJob(
    db,
    TEXT_EMBEDDING,
    { count: options.minDocuments ?? MIN_DOCUMENTS, unit: 'consented documents' },
    corpusOf(db),
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
    { count: options.minDocuments ?? MIN_DOCUMENTS, unit: 'consented documents' },
    corpusOf(db),
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

/**
 * Learned routing (ADR 0013): from settled routes, not posts, so it isn't
 * gated by the model_training consent (that covers learning from what people
 * wrote). The model is a few dozen numbers about factors, nothing about any person.
 */
export function trainRoutingJob(
  db: Pick<Database, 'asSystem'>,
  options: { run?: (input: RoutingInput) => Promise<RoutingResult>; minRoutes?: number } = {},
): Promise<TrainingOutcome<RoutingResult>> {
  return trainJob(
    db,
    ROUTING,
    { count: options.minRoutes ?? MIN_ROUTES, unit: 'settled routes' },
    async () => {
      const loaded = await loadRoutingExamples(db);
      return { ...loaded, size: loaded.examples.length };
    },
    async (data, serving) =>
      (options.run ?? runRoutingOnWorker)({
        examples: data.examples,
        modelRanked: data.modelRanked,
        serving,
        since: await lastRejectedAt(db, ROUTING),
      }),
    result => ({
      algorithm: ROUTING_ALGORITHM,
      params: { ...result.params },
      dataset: result.dataset,
      metrics: { ...result.metrics, difference: result.decision.difference },
      baseline: result.baseline,
    }),
  );
}

/**
 * The learned search ranking (ADR 0015 part 6): from searches recorded under
 * "improve search for everyone", not posts, so it isn't gated by the
 * model_training consent. A model is a few hundred trees over result
 * features, nothing about any person. Passing its offline gate makes it a
 * candidate: online comparison (search/judge.ts) decides whether it serves.
 */
export function trainSearchRankerJob(
  db: Pick<Database, 'asSystem'>,
  options: { run?: (input: SearchRankerInput) => Promise<SearchRankerResult>; minSearches?: number } = {},
): Promise<TrainingOutcome<SearchRankerResult>> {
  return trainJob(
    db,
    SEARCH_RANKER,
    { count: options.minSearches ?? MIN_SEARCHES, unit: 'recorded searches' },
    async () => {
      const loaded = await loadSearchTraining(db);
      return { ...loaded, size: loaded.searches.length };
    },
    (data, serving) => (options.run ?? runSearchRankerOnWorker)({ searches: data.searches, serving }),
    result => ({
      algorithm: SEARCH_RANKER_ALGORITHM,
      params: { ...result.params },
      dataset: result.dataset,
      metrics: { ...result.metrics, difference: result.decision.difference },
      baseline: result.baseline,
    }),
    'candidate',
  );
}
