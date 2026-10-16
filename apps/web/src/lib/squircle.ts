// Continuous-corner rectangles ("squircles"), the shape Apple uses for icons,
// buttons and cards. A plain border-radius joins a quarter circle to a
// straight edge abruptly; here each corner eases out of the edge with Bézier
// curves before the arc, so the curvature has no visible kink.
//
// The geometry follows the corner-smoothing construction used by Figma and
// published in the figma-squircle package (MIT); this is a fresh
// implementation of that math for uniform corners.

/** Apple's iOS corners are close to 60% smoothing. */
export const IOS_SMOOTHING = 0.6;

interface Corner {
  a: number;
  b: number;
  c: number;
  d: number;
  p: number;
  arc: number;
  r: number;
}

const rad = (deg: number) => (deg * Math.PI) / 180;

function corner(radius: number, smoothing: number, budget: number): Corner {
  const r = Math.min(radius, budget);
  // When the shape is too small for full smoothing, smooth less rather than
  // letting corners overlap.
  const s = r > 0 ? Math.max(0, Math.min(smoothing, budget / r - 1)) : 0;
  const p = Math.min((1 + s) * r, budget);
  const arcMeasure = 90 * (1 - s);
  const arc = Math.sin(rad(arcMeasure / 2)) * r * Math.SQRT2;
  const alpha = (90 - arcMeasure) / 2;
  const p3ToP4 = r * Math.tan(rad(alpha / 2));
  const beta = 45 * s;
  const c = p3ToP4 * Math.cos(rad(beta));
  const d = c * Math.tan(rad(beta));
  const b = (p - arc - c - d) / 3;
  return { a: 2 * b, b, c, d, p, arc, r };
}

const n = (x: number) => String(Math.round(x * 1000) / 1000);

/** SVG path data for a width × height squircle with uniform corners. */
export function squirclePath(width: number, height: number, radius: number, smoothing = IOS_SMOOTHING): string {
  if (width <= 0 || height <= 0) return '';
  const k = corner(Math.max(0, radius), smoothing, Math.min(width, height) / 2);
  const { a, b, c, d, p, arc, r } = k;
  if (r === 0) return `M 0 0 H ${n(width)} V ${n(height)} H 0 Z`;
  const abc = a + b + c;
  return [
    `M ${n(width - p)} 0`,
    // top-right
    `c ${n(a)} 0 ${n(a + b)} 0 ${n(abc)} ${n(d)}`,
    `a ${n(r)} ${n(r)} 0 0 1 ${n(arc)} ${n(arc)}`,
    `c ${n(d)} ${n(c)} ${n(d)} ${n(b + c)} ${n(d)} ${n(abc)}`,
    `L ${n(width)} ${n(height - p)}`,
    // bottom-right
    `c 0 ${n(a)} 0 ${n(a + b)} ${n(-d)} ${n(abc)}`,
    `a ${n(r)} ${n(r)} 0 0 1 ${n(-arc)} ${n(arc)}`,
    `c ${n(-c)} ${n(d)} ${n(-(b + c))} ${n(d)} ${n(-abc)} ${n(d)}`,
    `L ${n(p)} ${n(height)}`,
    // bottom-left
    `c ${n(-a)} 0 ${n(-(a + b))} 0 ${n(-abc)} ${n(-d)}`,
    `a ${n(r)} ${n(r)} 0 0 1 ${n(-arc)} ${n(-arc)}`,
    `c ${n(-d)} ${n(-c)} ${n(-d)} ${n(-(b + c))} ${n(-d)} ${n(-abc)}`,
    `L 0 ${n(p)}`,
    // top-left
    `c 0 ${n(-a)} 0 ${n(-(a + b))} ${n(d)} ${n(-abc)}`,
    `a ${n(r)} ${n(r)} 0 0 1 ${n(arc)} ${n(-arc)}`,
    `c ${n(c)} ${n(-d)} ${n(b + c)} ${n(-d)} ${n(abc)} ${n(-d)}`,
    'Z',
  ].join(' ');
}

/** Exposed for tests: how far each corner reaches along an edge. */
export function cornerExtent(width: number, height: number, radius: number, smoothing = IOS_SMOOTHING): number {
  return corner(Math.max(0, radius), smoothing, Math.min(width, height) / 2).p;
}
