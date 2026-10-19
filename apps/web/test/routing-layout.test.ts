import { describe, expect, it } from 'vitest';
import { along, ARRIVAL, arrivalSwell, bendFor, MAX_DRAWN, routingLayout, stagger, travel } from '../src/lib/routing-layout.ts';
import { must } from './must.ts';

describe('the picture of a question travelling', () => {
  it('puts the asker left and the people it reached inside a circle on the right', () => {
    const { asker, centre, radius, people } = routingLayout(10, 360, 180);
    expect(asker.x).toBeLessThan(centre.x);
    expect(people).toHaveLength(10);
    for (const p of people) expect(Math.hypot(p.x - centre.x, p.y - centre.y)).toBeLessThanOrEqual(radius + 1e-9);
    expect(radius).toBeLessThanOrEqual(180 * 0.4);
  });

  it('draws at most a readable number, and nobody for none', () => {
    expect(routingLayout(1000, 360, 180).people).toHaveLength(MAX_DRAWN);
    expect(routingLayout(0, 360, 180).people).toEqual([]);
  });

  it('runs each path from the asker to the person, curving to alternate sides', () => {
    const from = { x: 0, y: 0 }, to = { x: 100, y: 0 };
    expect(along(from, to, 0, 0.2)).toEqual(from);
    expect(along(from, to, 1, 0.2)).toEqual(to);
    expect(must(along(from, to, 0.5, bendFor(0))).y).toBeGreaterThan(0);
    expect(must(along(from, to, 0.5, bendFor(1))).y).toBeLessThan(0);
  });

  it('fans out in about a second however many were asked', () => {
    expect(stagger(1)).toBe(0);
    expect(stagger(10) * 9).toBeLessThanOrEqual(1);
    expect(stagger(140) * 139).toBeLessThanOrEqual(1);
  });

  it('travels smoothly from 0 to 1 and stays there', () => {
    expect(travel(-1)).toBe(0);
    expect(travel(0)).toBe(0);
    let last = 0;
    for (let t = 0.05; t < 3; t += 0.05) {
      const k = travel(t);
      expect(k).toBeGreaterThanOrEqual(last - 1e-9);
      last = k;
    }
    expect(travel(3)).toBeCloseTo(1, 3);
  });

  it('reaches each person in well under a second, on the spatial spring', () => {
    expect(ARRIVAL).toBeGreaterThan(0.3);
    expect(ARRIVAL).toBeLessThan(1);
    expect(travel(ARRIVAL)).toBe(1);
    expect(travel(ARRIVAL - 0.01)).toBeLessThan(1);
  });

  it('swells a reached person and lets them settle with a little give', () => {
    expect(arrivalSwell(-0.1)).toBe(1);
    expect(arrivalSwell(0)).toBeCloseTo(1.8, 6);
    let low = Infinity;
    for (let t = 0; t < 2; t += 0.005) low = Math.min(low, arrivalSwell(t));
    // Dips just below its size once (the pulse's resonance), never far.
    expect(low).toBeLessThan(1);
    expect(low).toBeGreaterThan(0.9);
    expect(arrivalSwell(3)).toBeCloseTo(1, 3);
  });
});
