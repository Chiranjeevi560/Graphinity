#!/usr/bin/env node
// Benchmarks collusion detection (docs/adr/0017-collusion-detection.md) on a
// pick graph shaped like Graphinity's: who picked whose answer. Honest askers
// pick answers from experts, popular ones far more often. Planted on top:
// - dense rings: 3 to 12 accounts picking each other's answers;
// - rotation rings: 6 to 12 accounts each picking only the next two around a
//   circle, so no one ever picks back directly;
// - sockpuppet stars: 5 to 14 new accounts all picking one beneficiary.
// Each fake account adds camouflage: picks of popular honest answerers. With
// `genuine`, honest askers also pick each ring member that many times (rings
// whose members also answer well).
//
// Methods, each flagging accounts:
// - reciprocity: pairs who picked each other at least twice each way;
// - Fraudar (Hooi et al. 2016) blocks, each connected part's closed core
//   (accounts both picking and picked in it) judged by lift;
// - closure (src/ml/collusion.ts): the largest set picked mostly from inside,
//   split into strongly connected parts, judged by lift.
// Ring precision and recall count ring members; puppet stars are reported on
// their own, as only network marks can tell them from a niche expert.
//
//   node scripts/benchmark-fraud.mjs [accounts]   (default 5000)
import { findRings, lift, RING_DEFAULTS } from '../apps/api/src/ml/collusion.ts';
import { denseBlocks } from '../apps/api/src/ml/fraudar.ts';
import { seededRandom } from '../apps/api/src/ml/linalg.ts';

const N = Number(process.argv[2] ?? 5000);

function honest(r) {
  const edges = [];
  for (let s = 0; s < N; s++) {
    const picks = 1 + Math.floor(r() * 8);
    for (let k = 0; k < picks; k++) edges.push({ source: s, target: Math.floor(N * r() ** 2) });
  }
  return edges;
}

function attack(r, camouflage, genuine) {
  const edges = [];
  const rings = new Set();
  const puppets = new Set();
  let next = N;
  for (let g = 0; g < 10; g++) {
    const ring = Array.from({ length: 3 + Math.floor(r() * 10) }, () => next++);
    ring.forEach(a => rings.add(a));
    for (const a of ring)
      for (const b of ring)
        if (a !== b && r() < 0.8) edges.push({ source: a, target: b, count: 1 + Math.floor(r() * 2) });
  }
  for (let g = 0; g < 5; g++) {
    const ring = Array.from({ length: 6 + Math.floor(r() * 7) }, () => next++);
    ring.forEach(a => rings.add(a));
    ring.forEach((a, i) => {
      for (let k = 1; k <= 2; k++)
        edges.push({ source: a, target: ring[(i + k) % ring.length], count: 1 + Math.floor(r() * 2) });
    });
  }
  for (let g = 0; g < 5; g++) {
    const beneficiary = next++;
    puppets.add(beneficiary);
    for (let k = 5 + Math.floor(r() * 10); k > 0; k--) {
      const puppet = next++;
      puppets.add(puppet);
      edges.push({ source: puppet, target: beneficiary, count: 1 + Math.floor(r() * 3) });
    }
  }
  for (const a of [...rings, ...puppets])
    for (let k = 0; k < camouflage; k++) edges.push({ source: a, target: Math.floor(N * r() ** 2 * 0.1) });
  for (const a of rings) for (let k = 0; k < genuine; k++) edges.push({ source: Math.floor(r() * N), target: a });
  return { edges, rings, puppets };
}

function reciprocity(edges) {
  const count = new Map();
  for (const e of edges)
    count.set(`${e.source}>${e.target}`, (count.get(`${e.source}>${e.target}`) ?? 0) + (e.count ?? 1));
  const flagged = new Set();
  for (const [key, c] of count) {
    const [a, b] = key.split('>');
    if (a !== b && c >= 2 && (count.get(`${b}>${a}`) ?? 0) >= 2) {
      flagged.add(Number(a));
      flagged.add(Number(b));
    }
  }
  return flagged;
}

/** Fraudar's blocks, each judged on its closed core by the same bars as the closure. */
function fraudar(edges) {
  const flagged = new Set();
  for (const b of denseBlocks(edges, 200, { weighted: true })) {
    const sources = new Set(b.sources);
    const core = b.targets.filter(t => sources.has(t));
    if (core.length < RING_DEFAULTS.minSize) continue;
    const l = lift(core, edges);
    if (l.inside >= RING_DEFAULTS.minInside && l.lift >= RING_DEFAULTS.minLift) core.forEach(x => flagged.add(x));
  }
  return flagged;
}

function closure(edges) {
  return new Set(findRings(edges).flatMap(r => r.members));
}

const score = (flagged, rings, puppets) => {
  const tp = [...flagged].filter(x => rings.has(x)).length;
  const honestFlagged = [...flagged].filter(x => !rings.has(x) && !puppets.has(x)).length;
  const precision = flagged.size ? (flagged.size - honestFlagged) / flagged.size : 1;
  return {
    flagged: flagged.size,
    precision: +precision.toFixed(3),
    recall: +(tp / rings.size).toFixed(3),
    honestFlagged,
    puppetRecall: +([...flagged].filter(x => puppets.has(x)).length / puppets.size).toFixed(3),
  };
};

const timed = f => {
  const t = performance.now();
  const flagged = f();
  return { flagged, ms: Math.round(performance.now() - t) };
};

const results = [];
for (const genuine of [0, 3])
  for (const camouflage of [0, 5, 20, 50]) {
    const r = seededRandom(1 + camouflage + 100 * genuine);
    const base = honest(r);
    const { edges, rings, puppets } = attack(r, camouflage, genuine);
    const all = [...base, ...edges];
    const row = { camouflage, genuine, picks: all.length, ringMembers: rings.size, puppetAccounts: puppets.size };
    for (const [name, method] of [
      ['reciprocity', reciprocity],
      ['fraudar', fraudar],
      ['closure', closure],
    ]) {
      const t = timed(() => method(all));
      row[name] = { ...score(t.flagged, rings, puppets), ms: t.ms, honestGraphFlagged: method(base).size };
    }
    results.push(row);
  }

// The lift the bar must clear: the most extreme part an honest graph produces
// with a looser share and no lift bar at all.
const honestMax = Math.max(
  0,
  ...[1, 2, 3].flatMap(seed => findRings(honest(seededRandom(seed)), { minLift: 0, minShare: 0.34 }).map(r => r.lift)),
);
console.log(
  JSON.stringify(
    { accounts: N, bars: RING_DEFAULTS, honestMaxLiftAtLooserShare: +honestMax.toFixed(2), results },
    null,
    1,
  ),
);
