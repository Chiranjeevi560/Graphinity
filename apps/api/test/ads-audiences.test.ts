import { describe, expect, it } from 'vitest';
import {
  cooling,
  inSegment,
  interestVector,
  lookAlike,
  MIN_AUDIENCE,
  parseRule,
  RETARGET_TAU_MS,
  shownSize,
  sphericalKMeans,
  type Person,
} from '../src/ads/audiences.ts';
import { seededRandom } from '../src/ml/linalg.ts';

const person = (adId: string, interests: Record<string, number>, country = 'IN', fields: string[] = []): Person => ({
  adId,
  country,
  fields,
  interests: new Map(Object.entries(interests)),
});

describe('segments', () => {
  const p = person('a', { travel: 2, money: 0.3 }, 'IN', ['imports-customs']);
  it('need every "all" condition and, when given, one of "any"', () => {
    expect(inSegment({ all: [{ interest: 'travel' }, { country: 'IN' }] }, p)).toBe(true);
    expect(inSegment({ all: [{ interest: 'money' }] }, p)).toBe(false);
    expect(inSegment({ all: [{ interest: 'money', min: 0.2 }] }, p)).toBe(true);
    expect(inSegment({ all: [{ country: 'US' }] }, p)).toBe(false);
    expect(
      inSegment({ all: [{ field: 'imports-customs' }], any: [{ country: 'US' }, { interest: 'travel' }] }, p),
    ).toBe(true);
    expect(inSegment({ all: [{ field: 'imports-customs' }], any: [{ country: 'US' }] }, p)).toBe(false);
    expect(inSegment({ all: [{ field: 'health' }] }, p)).toBe(false);
  });

  it('match nobody when a stored rule is malformed', () => {
    expect(parseRule({ all: [{ country: 'IN' }], any: [{ interest: 'travel', min: 2 }] })).toEqual({
      all: [{ country: 'IN' }],
      any: [{ interest: 'travel', min: 2 }],
    });
    for (const bad of [
      null,
      [],
      { all: [] },
      { all: [{ country: 'india' }] },
      { all: [{ interest: 'Travel' }] },
      { all: [{ interest: 'travel', min: 0 }] },
      { all: [{ interest: 'travel', extra: 1 }] },
      { all: [{ field: 'x' }], other: true },
      { all: [{ field: 'x' }], any: 'no' },
      { all: Array.from({ length: 21 }, () => ({ field: 'x' })) },
    ])
      expect(parseRule(bad), JSON.stringify(bad)).toBeNull();
  });
});

describe('interest vectors and k-means', () => {
  it('are unit length, and zero for nobody', () => {
    const v = interestVector(person('a', { travel: 3, money: 4 }), ['money', 'travel']);
    expect(v[0]).toBeCloseTo(0.8, 12);
    expect(v[1]).toBeCloseTo(0.6, 12);
    expect([...interestVector(person('b', {}), ['money'])]).toEqual([0]);
  });

  it('finds planted directions, reproducibly', () => {
    const r = seededRandom(3);
    const pts: Float64Array[] = [];
    for (let i = 0; i < 60; i++) {
      const axis = i % 3;
      const v = new Float64Array(3).map((_, j) => (j === axis ? 1 : 0.1 * r()));
      pts.push(interestVector(person(String(i), { a: v[0] ?? 0, b: v[1] ?? 0, c: v[2] ?? 0 }), ['a', 'b', 'c']));
    }
    const centres = sphericalKMeans(pts, 3, seededRandom(9));
    const axes = centres.map(c => [...c].indexOf(Math.max(...c))).sort();
    expect(axes).toEqual([0, 1, 2]);
    expect(sphericalKMeans(pts, 3, seededRandom(9))).toEqual(centres);
    expect(sphericalKMeans([], 3, seededRandom(1))).toEqual([]);
    // Fewer points than centres: one centre a point.
    expect(sphericalKMeans(pts.slice(0, 2), 5, seededRandom(1))).toHaveLength(2);
  });
});

describe('look-alikes', () => {
  const topics = ['cooking', 'money', 'travel', 'visa'];
  // Travellers (the seed's kind), cooks, and generalists who like everything a little.
  const world = (n: number) => {
    const r = seededRandom(11);
    const people: Person[] = [];
    for (let i = 0; i < n; i++) {
      const kind = i % 4;
      const jitter = () => 0.2 * r();
      const interests =
        kind === 0 || kind === 1
          ? { travel: 2 + jitter(), visa: 1 + jitter(), money: jitter() }
          : kind === 2
            ? { cooking: 2 + jitter(), money: jitter() }
            : { cooking: 1, money: 1, travel: 1, visa: 1 };
      people.push(person(`p${String(i).padStart(5, '0')}`, interests));
    }
    return people;
  };

  it('picks people like the seed, not generalists, and never the seed itself', () => {
    const people = world(20_000);
    const seed = people.filter((_, i) => i % 4 === 0).slice(0, 400);
    const result = lookAlike(seed, people, topics, 0.05, seededRandom(1));
    // 5% of the 19,600 people outside the seed.
    expect(result.members).toHaveLength(980);
    expect(result.centres).toBe(8);
    const seedIds = new Set(seed.map(p => p.adId));
    expect(result.members.some(id => seedIds.has(id))).toBe(false);
    // Every chosen person is a traveller (kind 0 or 1).
    const kindOf = (id: string) => Number(id.slice(1)) % 4;
    expect(result.members.every(id => kindOf(id) <= 1)).toBe(true);
  });

  it('refuses a seed or a result under the floor', () => {
    const people = world(4000);
    const seed = people.filter((_, i) => i % 4 === 0);
    expect(lookAlike(seed.slice(0, MIN_AUDIENCE - 1), people, topics, 0.05, seededRandom(1)).members).toEqual([]);
    // 1% of ~3,900 candidates is 39 people: under the floor, so nothing.
    const small = lookAlike(seed.slice(0, 200), people, topics, 0.01, seededRandom(1));
    expect(small.members).toEqual([]);
    expect(small.threshold).toBeNull();
  });
});

describe('reminders and sizes', () => {
  it('cool by e^(−Δt/τ)', () => {
    expect(cooling(0)).toBe(1);
    expect(cooling(RETARGET_TAU_MS)).toBeCloseTo(Math.exp(-1), 12);
    expect(cooling(-5)).toBe(1);
  });

  it('show no size under the floor, and round down to a hundred above it', () => {
    expect([shownSize(0), shownSize(99), shownSize(100), shownSize(1299)]).toEqual([null, null, 100, 1200]);
  });
});
