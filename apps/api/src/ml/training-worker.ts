// Runs on a worker thread (training.ts starts it): training and evaluation are
// seconds to minutes of pure CPU, and must never hold up a request on the
// server's main thread.
import { parentPort, workerData } from 'node:worker_threads';
import { trainAndEvaluate } from './train-embedding.ts';
import { trainSpellingAndEvaluate } from './train-spelling.ts';
import type { WorkerJob } from './training.ts';

if (!parentPort) throw new Error('training-worker.ts runs only as a worker thread');
const port = parentPort;
try {
  const job = workerData as WorkerJob;
  const result = job.job === 'spelling' ? trainSpellingAndEvaluate(job.input) : trainAndEvaluate(job.input);
  port.postMessage({ ok: true, result }, result.artifact ? [result.artifact.buffer as ArrayBuffer] : []);
} catch (err) {
  port.postMessage({ ok: false, error: err instanceof Error ? err.message : 'training failed' });
}
