#!/usr/bin/env node
// What choosing ads costs per request (docs/adr/0022-advertising-platform.md
// part 4), at 1,000 to 100,000 active campaigns spread over Graphinity's
// topics, each targeting a topic and some a keyword, country or interest:
// p50 and p95 of choose() (matching, pacing, caps, auction), in process,
// excluding the database round trips (one read for a signed-in reader, one
// insert per ad shown).
//
//   node scripts/benchmark-ad-serving.mjs
import { choose, indexCampaigns } from '../apps/api/src/ads/serve.ts';
import { seededRandom } from '../apps/api/src/ml/linalg.ts';

const FIELDS = Array.from({ length: 40 }, (_, i) => `topic-${String.fromCharCode(97 + (i % 26))}${i >= 26 ? 'x' : ''}`);
const WORDS = Array.from({ length: 2000 }, (_, i) => `w${String(i)}`);

function campaigns(n, r) {
  return Array.from({ length: n }, (_, i) => {
    const targets = new Map([['field', new Set([FIELDS[Math.floor(r() * FIELDS.length)]])]]);
    if (r() < 0.3) targets.set('keyword', new Set([WORDS[Math.floor(r() * WORDS.length)]]));
    if (r() < 0.3) targets.set('country', new Set(['IN']));
    if (r() < 0.2) targets.set('interest', new Set([FIELDS[Math.floor(r() * FIELDS.length)]]));
    return {
      id: String(i),
      advertiser: `b${String(i)}`,
      advertiserId: `a${String(i)}`,
      maxCpcMicros: 10_000 + Math.floor(r() * 5_000_000),
      dailyBudgetMicros: 100_000_000,
      frequencyCap: 3,
      spentMicros: Math.floor(r() * 50_000_000),
      impressions: Math.floor(r() * 10_000),
      clicks: Math.floor(r() * 200),
      creatives: [{ id: `${String(i)}-1`, headline: 'h', body: 'b', domain: 'd.example' }],
      targets,
    };
  });
}

const now = Date.UTC(2026, 9, 26, 12);
const results = [];
for (const n of [1_000, 10_000, 100_000]) {
  const r = seededRandom(n);
  const all = indexCampaigns(campaigns(n, r));
  const times = [];
  for (let k = 0; k < 400; k++) {
    const ctx = {
      placement: 'search',
      fields: [FIELDS[Math.floor(r() * FIELDS.length)]],
      words: [WORDS[Math.floor(r() * WORDS.length)], WORDS[Math.floor(r() * WORDS.length)]],
      country: 'IN',
      interests: new Set([FIELDS[Math.floor(r() * FIELDS.length)]]),
    };
    const t = performance.now();
    choose(all, ctx, new Map(), now);
    times.push(performance.now() - t);
  }
  times.sort((a, b) => a - b);
  results.push({
    campaigns: n,
    p50Ms: +times[Math.floor(times.length * 0.5)].toFixed(3),
    p95Ms: +times[Math.floor(times.length * 0.95)].toFixed(3),
  });
}
console.log(JSON.stringify({ requests: 400, results }, null, 1));
