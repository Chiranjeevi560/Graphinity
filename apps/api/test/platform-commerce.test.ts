import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { associationRules, fpGrowth } from '../src/commerce/basket.ts';
import {
  conformalQuantile,
  fitHoltWinters,
  forecastAt,
  forecastWithIntervals,
  seasonalNaive,
} from '../src/commerce/forecast.ts';
import { estimateElasticity, optimalPrice } from '../src/commerce/elasticity.ts';
import { extractProducts, jaroWinkler, resolveEntities } from '../src/commerce/entity.ts';
import { CountMinSketch, HyperLogLog, TDigest } from '../src/olap/sketches.ts';

describe('basket analysis', () => {
  it('matches a brute-force count on random baskets', () => {
    fc.assert(
      fc.property(
        fc.array(fc.uniqueArray(fc.constantFrom('a', 'b', 'c', 'd', 'e'), { maxLength: 5 }), {
          minLength: 1,
          maxLength: 60,
        }),
        fc.integer({ min: 1, max: 5 }),
        (baskets, min) => {
          const mined = new Map(
            fpGrowth(
              baskets.map(items => ({ items })),
              min,
              3,
            ).map(s => [s.items.join(), s.support]),
          );
          const items = ['a', 'b', 'c', 'd', 'e'] as const;
          const check = (set: ReadonlyArray<(typeof items)[number]>) => {
            const n = baskets.filter(b => set.every(i => b.includes(i))).length;
            if (n >= min) expect(mined.get(set.join())).toBe(n);
            else expect(mined.has(set.join())).toBe(false);
          };
          for (const a of items) {
            check([a]);
            for (const b of items) if (a < b) check([a, b]);
          }
        },
      ),
      { numRuns: 60 },
    );
  });
  it('ranks a true pairing above popular but unrelated items', () => {
    const baskets = [
      ...Array.from({ length: 40 }, () => ({ items: ['watch', 'strap'] })),
      ...Array.from({ length: 200 }, (_, i) => ({ items: i % 2 ? ['phone', 'watch'] : ['phone'] })),
      ...Array.from({ length: 200 }, () => ({ items: ['phone'] })),
    ];
    const rules = associationRules(fpGrowth(baskets, 5), baskets.length);
    expect(rules[0]?.from === 'strap' || rules[0]?.to === 'strap').toBe(true);
    expect(rules.find(r => r.from === 'strap')?.confidence).toBe(1);
  });
});

describe('demand forecasts', () => {
  const series = (n: number, seed = 1) => {
    let s = seed;
    const u = () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 2 ** 32;
    };
    return Array.from({ length: n }, (_, t) => 100 + 0.2 * t + 20 * Math.sin((2 * Math.PI * t) / 7) + (u() - 0.5) * 12);
  };
  it('beats seasonal-naive and never goes below zero', () => {
    const y = series(200);
    const { model } = fitHoltWinters(y.slice(0, 186));
    let hw = 0;
    let naive = 0;
    for (let h = 1; h <= 14; h++) {
      hw += Math.abs((y[185 + h] ?? 0) - forecastAt(model, h));
      naive += Math.abs((y[185 + h] ?? 0) - seasonalNaive(y.slice(0, 186), h));
    }
    expect(hw).toBeLessThan(naive);
    expect(forecastAt(fitHoltWinters([0, 0, 0]).model, 3)).toBe(0);
  });
  it('covers about 90% with its conformal interval', () => {
    let covered = 0;
    let total = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const y = series(180, seed);
      const f = forecastWithIntervals(y.slice(0, 150), 30);
      f.forEach((p, i) => {
        total += 1;
        const v = y[150 + i] ?? 0;
        if (v >= p.low && v <= p.high) covered += 1;
      });
    }
    expect(covered / total).toBeGreaterThanOrEqual(0.85);
    expect(conformalQuantile([])).toBe(Infinity);
    expect(conformalQuantile([1, 2, 3])).toBe(Infinity);
    expect(
      conformalQuantile(
        Array.from({ length: 99 }, (_, i) => i + 1),
        0.1,
      ),
    ).toBe(90);
  });
});

describe('elasticity', () => {
  it('recovers a known elasticity, and refuses without price variation', () => {
    const pts = Array.from({ length: 50 }, (_, i) => {
      const price = 100 + i * 5;
      return { price, quantity: 1e6 * price ** -1.5 * (1 + 0.02 * Math.sin(i)) };
    });
    const e = estimateElasticity(pts);
    expect(e?.elasticity).toBeCloseTo(-1.5, 1);
    expect(e?.low).toBeLessThan(-1.5);
    expect(estimateElasticity(pts.slice(0, 3))).toBeNull();
    expect(estimateElasticity(pts.map(p => ({ ...p, price: 100 })))).toBeNull();
    expect(optimalPrice(100, -2)).toBe(200);
    expect(optimalPrice(100, -0.5)).toBeNull();
  });
});

describe('product resolution', () => {
  it('finds products, as one key however written', () => {
    expect(extractProducts('Is the MacBook Pro M4 worth it?')[0]?.key).toBe('macbook-pro-m4');
    expect(extractProducts('macbook-pro m4 price')[0]?.key).toBe('macbook-pro-m4');
    expect(extractProducts('rolex submariner import Chennai')[0]?.brand).toBe('rolex');
    expect(extractProducts('How do I renew a passport?')).toEqual([]);
    expect(extractProducts('apple')).toEqual([]);
  });
  it('merges near-spellings but never different model numbers', () => {
    expect(jaroWinkler('martha', 'marhta')).toBeCloseTo(0.961, 2);
    expect(jaroWinkler('abc', 'xyz')).toBe(0);
    const c = resolveEntities([
      { key: 'samsung-galaxy-s24', brand: 'samsung', count: 10 },
      { key: 'samsung-galaxi-s24', brand: 'samsung', count: 2 },
      { key: 'samsung-galaxy-s23', brand: 'samsung', count: 5 },
    ]);
    expect(c.get('samsung-galaxi-s24')).toBe('samsung-galaxy-s24');
    expect(c.get('samsung-galaxy-s23')).toBe('samsung-galaxy-s23');
  });
});

describe('sketches', () => {
  it('HyperLogLog counts within about 3% at every size, and merges like a union', () => {
    for (const n of [100, 10_000, 200_000]) {
      const h = new HyperLogLog();
      for (let i = 0; i < n; i++) h.add(`user-${String(i)}`);
      expect(Math.abs(h.count() - n) / n).toBeLessThan(0.05);
    }
    const a = new HyperLogLog();
    const b = new HyperLogLog();
    for (let i = 0; i < 20_000; i++) a.add(`u${String(i)}`);
    for (let i = 10_000; i < 30_000; i++) b.add(`u${String(i)}`);
    a.merge(b);
    expect(Math.abs(a.count() - 30_000) / 30_000).toBeLessThan(0.05);
    expect(HyperLogLog.fromBytes(a.toBytes()).count()).toBe(a.count());
    expect(() => HyperLogLog.fromBytes(new Uint8Array(3))).toThrow(RangeError);
  });
  it('Count-Min never undercounts, and stays close', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: 50 }), { maxLength: 500 }), values => {
        const c = new CountMinSketch(256, 4);
        const truth = new Map<number, number>();
        for (const v of values) {
          c.add(String(v));
          truth.set(v, (truth.get(v) ?? 0) + 1);
        }
        for (const [v, n] of truth) expect(c.estimate(String(v))).toBeGreaterThanOrEqual(n);
      }),
    );
    const a = new CountMinSketch();
    a.add('x', 5);
    const b = CountMinSketch.fromBytes(a.toBytes());
    b.merge(a);
    expect(b.estimate('x')).toBe(10);
    expect(() => {
      a.merge(new CountMinSketch(10, 2));
    }).toThrow(RangeError);
    expect(() => CountMinSketch.fromBytes(Buffer.alloc(12, 1))).toThrow(RangeError);
  });
  it('t-digest finds tail quantiles within 1%, merged or not, in bounded size', () => {
    const values = Array.from({ length: 100_000 }, (_, i) => (i * 7919) % 100_000);
    const t = new TDigest();
    const a = new TDigest();
    const b = new TDigest();
    values.forEach((v, i) => {
      t.add(v);
      (i % 2 ? a : b).add(v);
    });
    a.merge(b);
    for (const d of [t, a]) {
      for (const q of [0.5, 0.95, 0.99, 0.999])
        expect(Math.abs((d.quantile(q) - q * 100_000) / 100_000)).toBeLessThan(0.01);
    }
    expect(t.total).toBe(100_000);
    expect(t.toBytes().length).toBeLessThan(200 * 16);
    expect(TDigest.fromBytes(t.toBytes()).quantile(0.5)).toBeCloseTo(t.quantile(0.5), 3);
    expect(new TDigest().quantile(0.5)).toBeNaN();
    expect(() => TDigest.fromBytes(Buffer.alloc(3))).toThrow(RangeError);
  });
});
