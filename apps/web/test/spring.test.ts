import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Spring, settleTime, springPosition, springs, springToCss } from '../src/lib/spring.ts';

describe('springPosition', () => {
  it('starts at 0 and ends at 1', () => {
    for (const s of Object.values(springs)) {
      expect(springPosition(s, 0)).toBeCloseTo(0, 6);
      expect(springPosition(s, 5)).toBeCloseTo(1, 4);
    }
  });

  it('never overshoots when critically damped', () => {
    for (let t = 0; t < 2; t += 0.001) expect(springPosition(springs.smooth, t)).toBeLessThanOrEqual(1 + 1e-9);
  });

  it('overshoots a little when under-damped (0.8)', () => {
    let peak = 0;
    for (let t = 0; t < 2; t += 0.001) peak = Math.max(peak, springPosition(springs.sheet, t));
    expect(peak).toBeGreaterThan(1.01);
    expect(peak).toBeLessThan(1.05);
  });

  it('a shorter response arrives sooner', () => {
    expect(settleTime({ response: 0.2, dampingFraction: 1 })).toBeLessThan(settleTime({ response: 0.5, dampingFraction: 1 }));
  });
});

describe('springToCss', () => {
  it('produces a linear() curve from 0 to 1 and a duration', () => {
    const { easing, durationMs } = springToCss(springs.smooth);
    expect(easing).toMatch(/^linear\(0, [\d., ]+, 1\)$/);
    expect(easing.split(',').length).toBe(31);
    expect(durationMs).toBeGreaterThan(300);
    expect(durationMs).toBeLessThan(1500);
  });

  it('matches the values written in tokens.css, so the CSS cannot drift from the physics', () => {
    const css = readFileSync(new URL('../src/styles/tokens.css', import.meta.url), 'utf8');
    for (const [name, params] of Object.entries(springs)) {
      const { easing, durationMs } = springToCss(params);
      expect(css, name).toContain(`--spring-${name}: ${easing};`);
      expect(css, name).toContain(`--spring-${name}-duration: ${durationMs}ms;`);
    }
  });
});

describe('Spring (live, for gestures)', () => {
  it('settles on its target', () => {
    const s = new Spring(springs.move, 0);
    s.target = 100;
    let frames = 0;
    while (!s.step(1 / 60) && frames < 600) frames++;
    expect(s.value).toBe(100);
    expect(frames).toBeLessThan(120);
  });

  it('can be re-targeted mid-flight without its velocity jumping', () => {
    const s = new Spring(springs.move, 0);
    s.target = 100;
    for (let i = 0; i < 10; i++) s.step(1 / 60);
    const before = s.velocity;
    expect(before).toBeGreaterThan(0);
    s.target = 0; // reverse
    // Velocity is continuous: the change over a step shrinks with the step,
    // instead of jumping by a fixed amount the way a restarted animation does.
    const probe = (dt: number) => {
      const copy = new Spring(springs.move, s.value, s.velocity);
      copy.target = 0;
      copy.step(dt);
      return Math.abs(copy.velocity - before);
    };
    expect(probe(1 / 1000)).toBeLessThan(probe(1 / 100) / 5);
    s.step(1 / 1000);
    expect(s.velocity).toBeGreaterThan(0); // still moving forward for an instant: no brick wall
  });

  it('carries an initial velocity handed over from a finger', () => {
    const s = new Spring(springs.sheet, 0, 2000);
    s.step(1 / 60);
    expect(s.value).toBeGreaterThan(20);
  });

  it('stays stable through a long frame', () => {
    const s = new Spring(springs.smooth, 0);
    s.target = 1;
    s.step(1); // one second in one call
    expect(s.value).toBeCloseTo(1, 2);
  });
});
