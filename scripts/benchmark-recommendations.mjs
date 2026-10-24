import { performance } from 'node:perf_hooks';
import { rankRecommendations } from '../apps/api/src/recommendation-ranking.ts';

const candidateCount = 2450;
const measuredRounds = 250;
const candidates = Array.from({ length: candidateCount }, (_, index) => ({
  id: `question-${String(index).padStart(5, '0')}`,
  ranks: {
    field: index % 3 === 0 ? (index % 100) + 1 : null,
    search: index % 5 === 0 ? (index % 20) + 1 : null,
    reading: index % 7 === 0 ? (index % 25) + 1 : null,
    recent: index + 1,
  },
}));

for (let i = 0; i < 50; i += 1) rankRecommendations(candidates, 20);
const rssBefore = process.resourceUsage().maxRSS;
const durations = [];
for (let i = 0; i < measuredRounds; i += 1) {
  const started = performance.now();
  const result = rankRecommendations(candidates, 20);
  durations.push(performance.now() - started);
  if (result.length !== 20) throw new Error('benchmark produced an unexpected result count');
}
durations.sort((a, b) => a - b);
const percentile = p => durations[Math.ceil(p * durations.length) - 1] ?? 0;

console.log(
  JSON.stringify(
    {
      benchmark: 'recommendation-rank-fusion',
      input: 'deterministic synthetic source ranks; no user data',
      candidateCount,
      resultCount: 20,
      measuredRounds,
      latencyMs: {
        p50: Number(percentile(0.5).toFixed(3)),
        p95: Number(percentile(0.95).toFixed(3)),
        p99: Number(percentile(0.99).toFixed(3)),
        max: Number((durations.at(-1) ?? 0).toFixed(3)),
      },
      maxRssKiB: {
        beforeMeasuredRounds: rssBefore,
        afterMeasuredRounds: process.resourceUsage().maxRSS,
      },
      scope: 'in-process RRF fusion only; excludes Postgres, HTTP, and provider latency',
    },
    null,
    2,
  ),
);
