#!/usr/bin/env node
// What request metrics cost and how exact they are (docs/adr/0020-observability.md):
// - the recorder's time per request, over 40 route patterns, after warm-up;
// - how far histogram quantiles (p50, p95, p99) are from the exact ones on
//   latencies shaped like a web API's (log-normal), at three typical speeds,
//   as the worst relative error over 200 minutes of 300 requests each.
//
//   node scripts/benchmark-ops.mjs
import { BUCKETS_MS, bucketOf, createRecorder, quantileOf } from '../apps/api/src/ops/metrics.ts';
import { gaussian, seededRandom } from '../apps/api/src/ml/linalg.ts';

const routes = Array.from({ length: 40 }, (_, i) => `/route${String(i)}/:id`);
const r = seededRandom(1);
const g = gaussian(r);
const recorder = createRecorder();
for (let i = 0; i < 100_000; i++) recorder.record(routes[i % 40], 'GET', 200, 20);
recorder.flush();
const N = 2_000_000;
const t = process.hrtime.bigint();
for (let i = 0; i < N; i++) recorder.record(routes[i % 40], i % 7 ? 'GET' : 'POST', i % 97 ? 200 : 503, 5 + (i % 900));
const nsPerRecord = Number(process.hrtime.bigint() - t) / N;
const rows = recorder.flush().length;

const accuracy = {};
for (const [name, median] of [
  ['fast (median 20 ms)', 20],
  ['typical (median 80 ms)', 80],
  ['slow (median 400 ms)', 400],
]) {
  const worst = { p50: 0, p95: 0, p99: 0 };
  for (let m = 0; m < 200; m++) {
    const times = Array.from({ length: 300 }, () => median * Math.exp(0.6 * g()));
    const buckets = new Array(BUCKETS_MS.length + 1).fill(0);
    for (const ms of times) buckets[bucketOf(ms)]++;
    const sorted = times.sort((a, b) => a - b);
    for (const [key, q] of [
      ['p50', 0.5],
      ['p95', 0.95],
      ['p99', 0.99],
    ]) {
      const exact = sorted[Math.ceil(q * sorted.length) - 1];
      worst[key] = Math.max(worst[key], Math.abs((quantileOf(buckets, q) ?? 0) - exact) / exact);
    }
  }
  accuracy[name] = Object.fromEntries(Object.entries(worst).map(([k, v]) => [k, +v.toFixed(3)]));
}
console.log(
  JSON.stringify(
    {
      recorder: { nsPerRecord: +nsPerRecord.toFixed(1), routes: 40, rowsPerFlush: rows },
      worstRelativeQuantileError: accuracy,
    },
    null,
    1,
  ),
);
