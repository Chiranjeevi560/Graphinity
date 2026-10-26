#!/usr/bin/env node
// How should look-alike audiences be found (docs/adr/0022-advertising-platform.md
// part 7)? A simulated population over the 20 interest topics: people belong
// to one of 12 hidden "kinds" (a few topics they care about, with noise), and
// a fifth are generalists who like many popular topics a little. A seed
// audience is drawn from two kinds at once (a business's buyers are rarely
// one kind), and each method picks the top 5% of everyone else. Precision is
// the share picked who truly belong to one of the seed's kinds. Compared:
// - one centroid of the seed (cosine to its mean);
// - k-means centres, K = min(8, |seed| / 25), without popularity correction;
// - k-means centres with the popularity correction (shipped);
// - nearest seed neighbours by brute force (each candidate's best cosine to
//   any seed member): the quadratic baseline the charter rejects, timed.
//
//   node scripts/benchmark-lookalike.mjs [people] [seed]   (default 50000, 400)
import { centroid, interestVector, lookAlike, sphericalKMeans } from '../apps/api/src/ads/audiences.ts';
import { seededRandom } from '../apps/api/src/ml/linalg.ts';

const PEOPLE = Number(process.argv[2] ?? 50_000);
const SEED = Number(process.argv[3] ?? 400);
const TOPICS = Array.from({ length: 20 }, (_, i) => `t${String(i)}`);
const KINDS = 12;
function run(world) {
  const r = seededRandom(world);
  // Each kind cares about 3 of topics t5–t19, a different set for each kind (sets overlap, as
  // real interests do); popular topics t0–t4 are liked a little by most.
  const kindTopics = Array.from({ length: KINDS }, (_, k) => [5 + k, 5 + ((k + 4) % 15), 5 + ((k + 9) % 15)]);
  const people = [];
  for (let i = 0; i < PEOPLE; i++) {
    const generalist = r() < 0.2;
    const kind = generalist ? -1 : Math.floor(r() * KINDS);
    const interests = new Map();
    for (let t = 0; t < 5; t++) if (r() < 0.7) interests.set(`t${String(t)}`, (generalist ? 2.5 : 1.5) * r());
    if (!generalist) {
      // Each of a kind's topics shows only sometimes, and two stray interests add noise.
      for (const t of kindTopics[kind]) if (r() < 0.8) interests.set(`t${String(t)}`, 0.5 + 1.5 * r());
      for (let j = 0; j < 2; j++) interests.set(`t${String(5 + Math.floor(r() * 15))}`, r());
    } else for (let t = 5; t < 20; t++) if (r() < 0.3) interests.set(`t${String(t)}`, r());
    people.push({ adId: `p${String(i).padStart(6, '0')}`, country: 'IN', fields: [], interests, kind });
  }
  const seedKinds = new Set([0, 7]);
  const seed = people.filter(p => seedKinds.has(p.kind)).slice(0, SEED);
  const seedIds = new Set(seed.map(p => p.adId));
  const candidates = people.filter(p => !seedIds.has(p.adId));
  const take = Math.floor(candidates.length * 0.05);
  const precision = ids => {
    const byId = new Map(people.map(p => [p.adId, p]));
    return +(ids.filter(id => seedKinds.has(byId.get(id).kind)).length / ids.length).toFixed(3);
  };
  const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
  const vec = p => interestVector(p, TOPICS);
  const top = scored =>
    scored
      .sort((a, b) => b.score - a.score)
      .slice(0, take)
      .map(s => s.adId);

  const results = {};
  let t = performance.now();
  const mean = centroid(seed.map(vec), TOPICS.length);
  results.one_centroid = {
    precision: precision(top(candidates.map(p => ({ adId: p.adId, score: dot(vec(p), mean) })))),
  };
  results.one_centroid.ms = Math.round(performance.now() - t);

  t = performance.now();
  const centres = sphericalKMeans(seed.map(vec), Math.min(8, Math.floor(seed.length / 25)), seededRandom(1));
  results.kmeans_no_correction = {
    precision: precision(
      top(candidates.map(p => ({ adId: p.adId, score: Math.max(...centres.map(c => dot(vec(p), c))) }))),
    ),
    ms: Math.round(performance.now() - t),
  };

  t = performance.now();
  const shipped = lookAlike(seed, people, TOPICS, 0.05, seededRandom(1));
  results.kmeans_with_popularity_correction = {
    precision: precision(shipped.members),
    picked: shipped.members.length,
    centres: shipped.centres,
    ms: Math.round(performance.now() - t),
  };

  // The quadratic baseline, on a slice (it would take |seed| × |people| comparisons in full).
  const slice = candidates.slice(0, Math.min(candidates.length, 10_000));
  t = performance.now();
  const seedVecs = seed.map(vec);
  const nn = slice.map(p => {
    const u = vec(p);
    return { adId: p.adId, score: seedVecs.reduce((m, s) => Math.max(m, dot(u, s)), -1) };
  });
  const nnMs = performance.now() - t;
  const nnTop = nn
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.floor(slice.length * 0.05))
    .map(s => s.adId);
  results.nearest_seed_neighbour = {
    precision: precision(nnTop),
    msPerTenThousand: Math.round(nnMs),
    projectedMsAt100M: Math.round((nnMs / slice.length) * 1e8 * (SEED / 400)),
  };

  return { picked: take, baseRate: candidates.filter(p => seedKinds.has(p.kind)).length / candidates.length, results };
}

const WORLDS = [7, 8, 9, 10, 11];
const runs = WORLDS.map(run);
const summary = {};
for (const method of Object.keys(runs[0].results)) {
  const xs = runs.map(x => x.results[method].precision);
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1));
  summary[method] = {
    precision: +mean.toFixed(3),
    sd: +sd.toFixed(3),
    min: Math.min(...xs),
    ms: runs[0].results[method].ms ?? runs[0].results[method].msPerTenThousand,
  };
}
console.log(
  JSON.stringify(
    {
      people: PEOPLE,
      seed: SEED,
      worlds: WORLDS.length,
      picked: runs[0].picked,
      baseRate: +runs[0].baseRate.toFixed(3),
      summary,
      nearestNeighbourProjectedMsAt100M: runs[0].results.nearest_seed_neighbour.projectedMsAt100M,
    },
    null,
    1,
  ),
);
