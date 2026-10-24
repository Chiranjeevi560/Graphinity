// Runs on a worker thread (training.ts starts it): training and evaluation are
// seconds to minutes of pure CPU, and must never hold up a request on the
// server's main thread.
import { parentPort, workerData } from 'node:worker_threads';
import { trainAndEvaluate, type WorkerInput } from './train-embedding.ts';

if (!parentPort) throw new Error('training-worker.ts runs only as a worker thread');
const port = parentPort;
try {
  const result = trainAndEvaluate(workerData as WorkerInput);
  port.postMessage({ ok: true, result }, result.artifact ? [result.artifact.buffer as ArrayBuffer] : []);
} catch (err) {
  port.postMessage({ ok: false, error: err instanceof Error ? err.message : 'training failed' });
}
