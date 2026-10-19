import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fromPhysics, physics, Spring, settleTime, springPosition, springs, springToCss } from '../src/lib/spring.ts';

describe('springPosition', () => {
  it('starts at 0 and ends at 1', () => {
    for (const s of Object.values(springs)) {
      expect(springPosition(s, 0)).toBeCloseTo(0, 6);
      expect(springPosition(s, 5)).toBeCloseTo(1, 4);
    }
  });

  it('never overshoots when critically damped', () => {
    for (let t = 0; t < 2; t += 0.001) expect(springPosition({ response: 0.35, dampingFraction: 1 }, t)).toBeLessThanOrEqual(1 + 1e-9);
  });

  it('overshoots a little when under-damped (0.8)', () => {
    let peak = 0;
    for (let t = 0; t < 2; t += 0.001) peak = Math.max(peak, springPosition({ response: 0.3, dampingFraction: 0.8 }, t));
    expect(peak).toBeGreaterThan(1.01);
    expect(peak).toBeLessThan(1.05);
  });

  it('a shorter response arrives sooner', () => {
    expect(settleTime({ response: 0.2, dampingFraction: 1 })).toBeLessThan(settleTime({ response: 0.5, dampingFraction: 1 }));
  });
});

describe('the spec’s springs (§8.1)', () => {
  const peak = (name: keyof typeof springs) => {
    let top = 0;
    for (let t = 0; t < 3; t += 0.001) top = Math.max(top, springPosition(springs[name], t));
    return top - 1;
  };

  it('are the table’s mass, stiffness and damping, with the damping ratios it states', () => {
    expect(physics).toEqual({
      snappy: { mass: 1, stiffness: 380, damping: 34 },
      fluid: { mass: 1, stiffness: 260, damping: 28 },
      spatial: { mass: 1.2, stiffness: 140, damping: 24 },
      pulse: { mass: 0.8, stiffness: 180, damping: 16 },
    });
    expect(springs.snappy.dampingFraction).toBeCloseTo(0.872, 3);
    expect(springs.fluid.dampingFraction).toBeCloseTo(0.868, 3);
    expect(springs.spatial.dampingFraction).toBeCloseTo(0.925, 2);
    expect(springs.pulse.dampingFraction).toBeCloseTo(0.667, 3);
  });

  it('turn into the same motion as the equation, m x\u2032\u2032 + c x\u2032 + k x = 0', () => {
    // Integrated straight from the spec's equation, to compare against.
    for (const [name, { mass, stiffness, damping }] of Object.entries(physics)) {
      let x = 0, v = 0;
      const h = 1 / 10_000;
      for (let i = 0; i < 2000; i++) { v += ((-stiffness * (x - 1) - damping * v) / mass) * h; x += v * h; }
      expect(springPosition(fromPhysics({ mass, stiffness, damping }), 0.2), name).toBeCloseTo(x, 3);
    }
  });

  it('settle without visible bounce, except the pulse, which gives a little', () => {
    expect(peak('snappy')).toBeLessThan(0.01);
    expect(peak('fluid')).toBeLessThan(0.01);
    expect(peak('spatial')).toBeLessThan(0.001);
    expect(peak('pulse')).toBeGreaterThan(0.04);
    expect(peak('pulse')).toBeLessThan(0.08);
  });
});

describe('springToCss', () => {
  it('produces a linear() curve from 0 to 1 and a duration', () => {
    const { easing, durationMs } = springToCss(springs.snappy);
    expect(easing).toMatch(/^linear\(0, [\d., ]+, 1\)$/);
    expect(easing.split(',').length).toBe(31);
    expect(durationMs).toBeGreaterThan(300);
    expect(durationMs).toBeLessThan(1500);
  });

  it('matches the values written in tokens.css, so the CSS cannot drift from the physics', () => {
    const css = readFileSync(new URL('../src/styles/tokens.css', import.meta.url), 'utf8');
    // Spatial and pulse move the graph on its canvas; only these two are CSS.
    for (const name of ['snappy', 'fluid'] as const) {
      const { easing, durationMs } = springToCss(springs[name]);
      expect(css, name).toContain(`--spring-${name}: ${easing};`);
      expect(css, name).toContain(`--spring-${name}-duration: ${durationMs}ms;`);
    }
  });
});

describe('Spring (live, for gestures)', () => {
  it('settles on its target', () => {
    const s = new Spring(springs.fluid, 0);
    s.target = 100;
    let frames = 0;
    while (!s.step(1 / 60) && frames < 600) frames++;
    expect(s.value).toBe(100);
    expect(frames).toBeLessThan(120);
  });

  it('can be re-targeted mid-flight without its velocity jumping', () => {
    const s = new Spring(springs.fluid, 0);
    s.target = 100;
    for (let i = 0; i < 10; i++) s.step(1 / 60);
    const before = s.velocity;
    expect(before).toBeGreaterThan(0);
    s.target = 0; // reverse
    // Velocity is continuous: the change over a step shrinks with the step,
    // instead of jumping by a fixed amount the way a restarted animation does.
    const probe = (dt: number) => {
      const copy = new Spring(springs.fluid, s.value, s.velocity);
      copy.target = 0;
      copy.step(dt);
      return Math.abs(copy.velocity - before);
    };
    expect(probe(1 / 1000)).toBeLessThan(probe(1 / 100) / 5);
    s.step(1 / 1000);
    expect(s.velocity).toBeGreaterThan(0); // still moving forward for an instant: no brick wall
  });

  it('carries an initial velocity handed over from a finger', () => {
    const s = new Spring(springs.fluid, 0, 2000);
    s.step(1 / 60);
    expect(s.value).toBeGreaterThan(20);
  });

  it('stays stable through a long frame', () => {
    const s = new Spring(springs.snappy, 0);
    s.target = 1;
    s.step(1); // one second in one call
    expect(s.value).toBeCloseTo(1, 2);
  });
});
