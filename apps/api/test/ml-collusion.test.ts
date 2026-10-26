import { describe, expect, it } from 'vitest';
import { closure, findRings, lift, stronglyConnected, type PickEdge } from '../src/ml/collusion.ts';
import { seededRandom } from '../src/ml/linalg.ts';

/** Honest picking among `n` accounts: each asker picks a few answerers, popular ones far more often. */
function honest(n: number, seed = 1): PickEdge<number>[] {
  const r = seededRandom(seed);
  const edges: PickEdge<number>[] = [];
  for (let s = 0; s < n; s++) {
    const picks = 1 + Math.floor(r() * 8);
    for (let k = 0; k < picks; k++) edges.push({ source: s, target: Math.floor(n * r() ** 2) });
  }
  return edges;
}

/** Every member picks every other member `count` times. */
const dense = (members: readonly number[], count = 2): PickEdge<number>[] =>
  members.flatMap(a => members.filter(b => b !== a).map(b => ({ source: a, target: b, count })));

/** Each member picks only the next two around a circle: no one ever picks back directly. */
const rotation = (members: readonly number[]): PickEdge<number>[] =>
  members.flatMap((a, i) => [1, 2].map(k => ({ source: a, target: members[(i + k) % members.length] ?? a, count: 2 })));

/** Camouflage: each member also picks `k` popular honest accounts. */
const camouflage = (members: readonly number[], k: number, seed = 7): PickEdge<number>[] => {
  const r = seededRandom(seed);
  return members.flatMap(a => Array.from({ length: k }, () => ({ source: a, target: Math.floor(500 * r() ** 2) })));
};

const ringA = [5000, 5001, 5002, 5003, 5004, 5005];
const ringB = [6000, 6001, 6002, 6003, 6004, 6005, 6006, 6007];

describe('findRings', () => {
  it('finds nothing in honest picking alone', () => {
    expect(findRings(honest(5000))).toEqual([]);
  });

  it('finds a ring of accounts picking each other, exactly', () => {
    const rings = findRings([...honest(5000), ...dense(ringA)]);
    expect(rings.map(r => r.members)).toEqual([ringA]);
    const [ring] = rings;
    expect(ring?.inside).toBe(ringA.length * (ringA.length - 1) * 2);
    expect(ring?.lift).toBeGreaterThan(20);
  });

  it('finds a ring that never picks back directly', () => {
    expect(findRings([...honest(5000), ...rotation(ringB)]).map(r => r.members)).toEqual([ringB]);
  });

  it('still finds rings hidden behind heavy camouflage, and never flags the popular accounts they picked', () => {
    const edges = [
      ...honest(5000),
      ...dense(ringA),
      ...rotation(ringB),
      ...camouflage(ringA, 50),
      ...camouflage(ringB, 50, 8),
    ];
    const rings = findRings(edges);
    expect(rings.map(r => r.members).sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0))).toEqual([ringA, ringB]);
  });

  it('does not flag a niche expert whose few askers picked them, however often', () => {
    // Sockpuppet-shaped: five accounts all picking one answerer, never picked themselves.
    const star = [7001, 7002, 7003, 7004, 7005].map(s => ({ source: s, target: 7000, count: 3 }));
    expect(findRings([...honest(5000), ...star])).toEqual([]);
  });

  it('does not flag a pair, however much they pick each other', () => {
    expect(findRings([...honest(2000), ...dense([9000, 9001], 10)])).toEqual([]);
  });

  it('ranks the more extreme ring first, the same way every run', () => {
    const edges = [...honest(3000), ...dense(ringA), ...rotation(ringB)];
    const first = findRings(edges);
    expect(findRings([...edges].reverse())).toEqual(first);
    expect(first.length).toBe(2);
    expect(first[0]?.lift).toBeGreaterThanOrEqual(first[1]?.lift ?? Infinity);
  });

  it('works with text ids, as the database gives them', () => {
    const ids = ['c', 'a', 'b'];
    const rings = findRings(
      dense([0, 1, 2]).map(e => ({ ...e, source: ids[e.source] ?? '', target: ids[e.target] ?? '' })),
      {
        minLift: 0,
      },
    );
    expect(rings.map(r => r.members)).toEqual([['a', 'b', 'c']]);
  });

  it('ignores self-picks and empty input', () => {
    expect(findRings([])).toEqual([]);
    expect(findRings([{ source: 1, target: 1, count: 100 }])).toEqual([]);
  });

  it('applies each bar it is given', () => {
    const edges = [...honest(2000), ...dense(ringA, 1)];
    expect(findRings(edges).length).toBe(1);
    expect(findRings(edges, { minSize: 7 })).toEqual([]);
    expect(findRings(edges, { minInside: 31 })).toEqual([]);
    expect(findRings(edges, { minLift: 1e9 })).toEqual([]);
  });
});

describe('the steps', () => {
  it('closure keeps only accounts picked mostly from inside, and needs enough picks', () => {
    const edges: PickEdge<number>[] = [...dense([1, 2, 3], 1), { source: 9, target: 1 }, { source: 9, target: 1 }];
    // Account 1 gets 2 of 4 picks from outside: exactly half stays at 0.5, leaves above it.
    expect(closure(edges, 0.5, 2)).toEqual(new Set([1, 2, 3]));
    expect(closure(edges, 0.51, 2)).toEqual(new Set());
    expect(closure(dense([1, 2, 3], 1), 0.5, 3)).toEqual(new Set());
  });

  it('closure cascades: once one member leaves, those it propped up leave too', () => {
    // A chain 1 -> 2 -> 3 -> 4: nobody picks 1, so each falls in turn.
    const chain = [1, 2, 3].map(a => ({ source: a, target: a + 1, count: 5 }));
    expect(closure(chain, 0.5, 1)).toEqual(new Set());
  });

  it('strongly connected parts separate a ring from the popular account it props up', () => {
    const edges = [...dense([1, 2, 3]), { source: 1, target: 50 }, { source: 2, target: 50 }];
    const parts = stronglyConnected(new Set([1, 2, 3, 50]), edges).map(p => [...p].sort((a, b) => a - b));
    expect(parts.sort((a, b) => a.length - b.length)).toEqual([[50], [1, 2, 3]]);
  });

  it('lift compares picks among members with what their activity predicts', () => {
    const edges = [...dense([1, 2], 1), { source: 3, target: 4, count: 2 }];
    // Members give 2 and receive 2 of 4 picks: 1 expected, 2 happened.
    expect(lift([1, 2], edges)).toEqual({ inside: 2, expected: 1, lift: 2 });
    expect(lift([], [])).toEqual({ inside: 0, expected: 0, lift: 0 });
  });
});
