import { describe, expect, it } from 'vitest';
import { cornerExtent, squirclePath } from '../src/lib/squircle.ts';
import { must } from './must.ts';

/** Walks the path's commands and returns the pen position after each one. */
function trace(path: string): Array<[number, number]> {
  const tokens = path.split(/\s+/);
  const pts: Array<[number, number]> = [];
  let x = 0, y = 0, i = 0;
  const num = () => Number(tokens[i++]);
  while (i < tokens.length) {
    const cmd = tokens[i++];
    switch (cmd) {
      case 'M': case 'L': x = num(); y = num(); break;
      case 'H': x = num(); break;
      case 'V': y = num(); break;
      case 'c': { num(); num(); num(); num(); const dx = num(), dy = num(); x += dx; y += dy; break; }
      case 'a': { num(); num(); num(); num(); num(); const dx = num(), dy = num(); x += dx; y += dy; break; }
      case 'Z': break;
      default: throw new Error(`unexpected token ${cmd}`);
    }
    pts.push([x, y]);
  }
  return pts;
}

describe('squirclePath', () => {
  it('meets each straight edge exactly where the corner ends, and the last corner lands on the top edge', () => {
    for (const [w, h, r] of [[120, 44, 12], [44, 44, 22], [300, 80, 20], [10, 200, 30]] as const) {
      const p = cornerExtent(w, h, r);
      const pts = trace(squirclePath(w, h, r));
      // After each corner's three segments (curve, arc, curve) the pen sits on an edge.
      const ends = [3, 7, 11, 15].map(i => must(pts[i], `point ${i}`));
      const expected = [[w, p], [w - p, h], [0, h - p], [p, 0]];
      ends.forEach((pt, i) => {
        const [x, y] = must(expected[i], `corner ${i}`);
        expect(pt[0], `${w}x${h} corner ${i}`).toBeCloseTo(must(x), 2);
        expect(pt[1], `${w}x${h} corner ${i}`).toBeCloseTo(must(y), 2);
      });
      // The closing Z then draws the top edge back to the start at (w - p, 0).
      expect(pts[0]).toEqual([Math.round((w - p) * 1000) / 1000, 0]);
    }
  });

  it('stays inside its box', () => {
    for (const [w, h, r] of [[120, 44, 12], [44, 44, 40], [300, 80, 20]] as const) {
      for (const [x, y] of trace(squirclePath(w, h, r))) {
        expect(x).toBeGreaterThanOrEqual(-0.01);
        expect(y).toBeGreaterThanOrEqual(-0.01);
        expect(x).toBeLessThanOrEqual(w + 0.01);
        expect(y).toBeLessThanOrEqual(h + 0.01);
      }
    }
  });

  it('reaches further along the edge than a plain radius (that is the smoothing)', () => {
    expect(cornerExtent(200, 200, 20)).toBeCloseTo(32, 5); // (1 + 0.6) × 20
  });

  it('never lets corners overlap on small shapes', () => {
    expect(cornerExtent(44, 44, 40)).toBeLessThanOrEqual(22);
    expect(cornerExtent(10, 200, 30)).toBeLessThanOrEqual(5);
  });

  it('is a plain rectangle at radius 0 and empty at zero size', () => {
    expect(squirclePath(10, 20, 0)).toBe('M 0 0 H 10 V 20 H 0 Z');
    expect(squirclePath(0, 20, 5)).toBe('');
  });
});
