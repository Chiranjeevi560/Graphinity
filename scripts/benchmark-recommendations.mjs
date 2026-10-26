// The in-process cost of fusing recommendation sources (feed-rrf-v3, ADR 0016)
// at the largest candidate pools a request can produce: five sources of at
// most 100 each. Excludes Postgres and HTTP: scripts/benchmark-recommendations-v3.mjs
// measures whole requests, and quality.
import { performance } from 'node:perf_hooks';
import { fuseSources } from '../apps/api/src/recommendations/feed.ts';

const SOURCE_SIZE = 100;
const measuredRounds = 250;
// Overlapping lists, as real sources overlap: each id appears in up to three.
const list = offset => Array.from({ length: SOURCE_SIZE }, (_, i) => `q${String((i * 3 + offset) % 400)}`);
const ranked = { search: list(0), reading: list(1), co_answer: list(2), field: list(3), recent: list(4) };

for (let i = 0; i < 50; i += 1) fuseSources(ranked);
const rssBefore = process.resourceUsage().maxRSS;
const durations = [];
for (let i = 0; i < measuredRounds; i += 1) {
  const started = performance.now();
  const result = fuseSources(ranked);
  durations.push(performance.now() - started);
  if (result.length === 0) throw new Error('benchmark produced no candidates');
}
durations.sort((a, b) => a - b);
const percentile = p => durations[Math.ceil(p * durations.length) - 1] ?? 0;

console.log(
  JSON.stringify(
    {
      benchmark: 'recommendation-source-fusion',
      input: 'deterministic synthetic source lists; no user data',
      sources: Object.keys(ranked).length,
      perSource: SOURCE_SIZE,
      measuredRounds,
      latencyMs: {
        p50: Number(percentile(0.5).toFixed(3)),
        p95: Number(percentile(0.95).toFixed(3)),
        p99: Number(percentile(0.99).toFixed(3)),
        max: Number((durations.at(-1) ?? 0).toFixed(3)),
      },
      maxRssKiB: { beforeMeasuredRounds: rssBefore, afterMeasuredRounds: process.resourceUsage().maxRSS },
      scope: 'in-process RRF fusion only; excludes Postgres and HTTP',
    },
    null,
    2,
  ),
);
