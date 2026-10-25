// Runs personal graph analysis on one long-lived worker thread (ADR 0012).
// At the 1,000-node cap an analysis is ~165 ms of CPU (NetMF's matrix
// products), which on the main thread would hold up every other request.
// One worker runs them one at a time; a short queue absorbs bursts, and past
// it callers get GraphBusyError (the route answers 503 with plain words)
// rather than waiting behind work they can't see.
import { Worker } from 'node:worker_threads';
import type { PersonalGraphEdge, PersonalGraphInsights, PersonalGraphNode } from './personal-graph-algorithms.ts';

export class GraphBusyError extends Error {}

export interface GraphAnalysisInput {
  nodes: PersonalGraphNode[];
  edges: PersonalGraphEdge[];
  seedNodeIds: string[];
  limit: number;
}

export interface GraphAnalyzer {
  analyze(input: GraphAnalysisInput): Promise<PersonalGraphInsights>;
  /** Analyses running or waiting: for logs. */
  depth(): number;
  close(): Promise<void>;
}

type Reply = { id: number; ok: true; insights: PersonalGraphInsights } | { id: number; ok: false; error: string };

/** Waiting beyond the one running. 8 × ~165 ms is a second and a half at worst. */
export const MAX_WAITING = 8;

export function createGraphAnalyzer(options: { maxWaiting?: number } = {}): GraphAnalyzer {
  const maxWaiting = options.maxWaiting ?? MAX_WAITING;
  const pending = new Map<number, { resolve: (v: PersonalGraphInsights) => void; reject: (e: Error) => void }>();
  let worker: Worker | null = null;
  let next = 0;
  let closed = false;

  const failAll = (error: Error) => {
    for (const p of pending.values()) p.reject(error);
    pending.clear();
  };
  const start = (): Worker => {
    const w = new Worker(new URL('./graph-worker.ts', import.meta.url));
    w.on('message', (m: Reply) => {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.ok) p.resolve(m.insights);
      else p.reject(new RangeError(m.error));
    });
    // A crashed worker fails what it held; the next call starts a fresh one.
    w.on('error', (err: unknown) => {
      worker = null;
      failAll(err instanceof Error ? err : new Error('graph worker failed'));
    });
    w.on('exit', () => {
      if (worker === w) worker = null;
      failAll(new Error('graph worker stopped'));
    });
    // Idle, it mustn't keep the process alive.
    w.unref();
    return w;
  };

  return {
    analyze(input) {
      if (closed) return Promise.reject(new Error('graph analyzer is closed'));
      if (pending.size > maxWaiting) return Promise.reject(new GraphBusyError('graph analysis queue is full'));
      worker ??= start();
      const id = next++;
      const w = worker;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        w.ref();
        try {
          w.postMessage({ id, input });
        } catch (err) {
          // Input that can't be copied to the worker: nothing was sent, so nothing waits for it.
          pending.delete(id);
          throw err;
        }
      }).finally(() => {
        if (pending.size === 0) worker?.unref();
      }) as Promise<PersonalGraphInsights>;
    },
    depth: () => pending.size,
    async close() {
      closed = true;
      const w = worker;
      worker = null;
      if (w) await w.terminate();
      failAll(new Error('graph analyzer is closed'));
    },
  };
}
