// The picture of one question travelling: the asker on the left, the people
// it reached gathered in their field on the right, and a curved path to
// each. Pure maths, so the drawing stays simple and this stays tested.
import { springPosition, springs } from './spring.ts';

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
/** Drawn at most: beyond this the cluster is just denser, not more legible. */
export const MAX_DRAWN = 150;

export interface Point { x: number; y: number }
export interface RoutingLayout { asker: Point; centre: Point; radius: number; people: Point[] }

export function routingLayout(count: number, width: number, height: number): RoutingLayout {
  const asker = { x: width * 0.16, y: height * 0.5 };
  const centre = { x: width * 0.66, y: height * 0.5 };
  const radius = Math.min(width * 0.28, height * 0.4);
  const n = Math.min(count, MAX_DRAWN);
  // Evenly filled, like seeds in a sunflower: no rows, no clumps.
  const people = Array.from({ length: n }, (_, i) => {
    const r = radius * Math.sqrt((i + 0.5) / n);
    return { x: centre.x + Math.cos(i * GOLDEN_ANGLE) * r, y: centre.y + Math.sin(i * GOLDEN_ANGLE) * r };
  });
  return { asker, centre, radius, people };
}

/**
 * A point along the curved path from `from` to `to`, k from 0 to 1. The
 * curve bends by `bend` (a fraction of the distance, sign = side), so paths
 * to different people fan out instead of lying on top of each other.
 */
export function along(from: Point, to: Point, k: number, bend: number): Point {
  const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
  const dx = to.x - from.x, dy = to.y - from.y;
  const control = { x: mid.x - dy * bend, y: mid.y + dx * bend };
  const u = 1 - k;
  return {
    x: u * u * from.x + 2 * u * k * control.x + k * k * to.x,
    y: u * u * from.y + 2 * u * k * control.y + k * k * to.y,
  };
}

/** Each path's bend: alternating sides, a little more for people further out. */
export function bendFor(index: number): number {
  return (index % 2 === 0 ? 1 : -1) * (0.08 + (index % 5) * 0.03);
}

/** Seconds between one path starting and the next: the fan-out takes about a second, however many. */
export function stagger(count: number): number {
  return count > 1 ? Math.min(0.06, 1 / count) : 0;
}

/** How far along its path a travelling question is, 0 to 1, `age` seconds after it set off. */
export function travel(age: number): number {
  if (age <= 0) return 0;
  return Math.min(1, springPosition(springs.move, age * 0.6));
}
