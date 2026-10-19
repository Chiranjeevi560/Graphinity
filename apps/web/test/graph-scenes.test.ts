import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCanvas, type Frame } from '../src/lib/canvas-loop.ts';
import type { GraphData } from '../src/lib/graph-layout.ts';
import { livingScene } from '../src/lib/living-scene.ts';
import { routingScene, type RoutingInputs } from '../src/lib/routing-scene.ts';
import { ARRIVAL } from '../src/lib/routing-layout.ts';

/** A 2D context that records what was drawn, enough to tell what's on screen. */
function recorder() {
  const arcs: Array<{ r: number; fill: string; alpha: number }> = [];
  const lines: number[] = [];
  let gradients = 0;
  const ctx = {
    globalAlpha: 1,
    fillStyle: '' as unknown,
    strokeStyle: '' as unknown,
    lineWidth: 1,
    clearRect() {
      arcs.length = 0;
      lines.length = 0;
      gradients = 0;
    },
    beginPath() {},
    moveTo() {},
    quadraticCurveTo() {},
    fill() {},
    setTransform() {},
    lineTo() {
      lines.push(ctx.globalAlpha);
    },
    stroke() {},
    arc(_x: number, _y: number, r: number) {
      arcs.push({ r, fill: String(ctx.fillStyle), alpha: ctx.globalAlpha });
    },
    createRadialGradient() {
      gradients += 1;
      return { addColorStop() {} };
    },
  };
  return {
    ctx: ctx as unknown as CanvasRenderingContext2D,
    arcs,
    lines,
    get gradients() {
      return gradients;
    },
  };
}

const colors = { ink: 'INK', accent: 'ACCENT' };

describe('the asker’s routing picture', () => {
  function scene(inputs: RoutingInputs) {
    const now = { ...inputs };
    const s = routingScene(() => now);
    const rec = recorder();
    s.resize(360, 160);
    const draw = (t: number, still = false) => {
      rec.ctx.clearRect(0, 0, 0, 0);
      s.draw({ ctx: rec.ctx, width: 360, height: 160, t, colors, still } satisfies Frame);
    };
    return { now, rec, draw };
  }
  const travelling = (arcs: Array<{ r: number }>) => arcs.filter(a => a.r === 2.4).length;
  const people = (arcs: Array<{ r: number }>) => arcs.filter(a => a.r === 2.6).length;

  it('shows a later visit settled: everyone reached, nothing travelling', () => {
    const { rec, draw } = scene({ asked: 5, answers: 0, fresh: false });
    draw(0);
    expect(people(rec.arcs)).toBe(5);
    expect(travelling(rec.arcs)).toBe(0);
  });

  it('plays the journey out once for a question just asked here', () => {
    const { rec, draw } = scene({ asked: 5, answers: 0, fresh: true });
    draw(0);
    draw(0.3);
    expect(travelling(rec.arcs)).toBeGreaterThan(0);
    draw(10);
    expect(travelling(rec.arcs)).toBe(0);
  });

  it('swells each person as the question reaches them, on the pulse spring, not with motion off', () => {
    // People's dots only: larger than resting, at most the swell's peak, not the answer pulse (3).
    const swollen = (arcs: Array<{ r: number }>) =>
      arcs.filter(a => a.r > 2.6 && a.r <= 2.6 * 1.8 + 1e-9 && a.r !== 3).length;
    const { rec, draw } = scene({ asked: 5, answers: 0, fresh: true });
    draw(0);
    draw(ARRIVAL + 0.02);
    expect(swollen(rec.arcs)).toBeGreaterThan(0);
    draw(10);
    expect(swollen(rec.arcs)).toBe(0);
    expect(people(rec.arcs)).toBe(5);
    const still = scene({ asked: 5, answers: 0, fresh: true });
    still.draw(0, true);
    still.draw(ARRIVAL + 0.02, true);
    expect(swollen(still.rec.arcs)).toBe(0);
    // Motion turned off while the question is on its way: it arrives without swelling.
    const midway = scene({ asked: 5, answers: 0, fresh: true });
    midway.draw(0);
    midway.draw(ARRIVAL + 0.02, true);
    expect(swollen(midway.rec.arcs)).toBe(0);
  });

  it('sends a new wave out while you watch', () => {
    const { now, rec, draw } = scene({ asked: 5, answers: 0, fresh: false });
    draw(0);
    now.asked = 10;
    draw(1);
    // Departures are staggered across the new wave: look half-way through.
    draw(1.5);
    expect(people(rec.arcs)).toBeGreaterThan(5);
    expect(travelling(rec.arcs)).toBeGreaterThan(0);
  });

  it('brings each new answer home as a pulse, but not with motion turned off', () => {
    const { now, rec, draw } = scene({ asked: 5, answers: 0, fresh: false });
    draw(0);
    now.answers = 1;
    draw(1);
    draw(1.3);
    expect(rec.arcs.filter(a => a.r === 3)).toHaveLength(1);
    const still = scene({ asked: 5, answers: 0, fresh: false });
    still.draw(0, true);
    still.now.answers = 1;
    still.draw(1, true);
    expect(still.rec.arcs.filter(a => a.r === 3)).toHaveLength(0);
  });

  it('draws "a few" as the field lighting up, never as single people', () => {
    const { rec, draw } = scene({ asked: null, answers: 0, fresh: false });
    draw(0);
    expect(rec.gradients).toBe(1);
    expect(people(rec.arcs)).toBe(0);
  });

  it('breathes while the question is still going out', () => {
    const { rec, draw } = scene({ asked: undefined, answers: 0, fresh: true });
    draw(0);
    const first = rec.arcs.map(a => a.r);
    draw(0.7);
    expect(rec.arcs.map(a => a.r)).not.toEqual(first);
    expect(people(rec.arcs)).toBe(0);
  });
});

describe('the home graph', () => {
  const data: GraphData = {
    members: 12,
    fields: [
      { slug: 'a', name: 'A', members: 8 },
      { slug: 'b', name: 'B', members: 4 },
    ],
    people: [...Array.from({ length: 8 }, () => [0]), ...Array.from({ length: 4 }, () => [1])],
    activity: {
      lastDay: { questions: 1, answers: 1 },
      recent: [
        { field: 0, kind: 'answer' },
        { field: 1, kind: 'question' },
      ],
    },
  };
  function draw(you: number[] | undefined, ts: number[], still = false) {
    const s = livingScene(data, you);
    const rec = recorder();
    s.resize(360, 280);
    for (const t of ts) {
      rec.ctx.clearRect(0, 0, 0, 0);
      s.draw({ ctx: rec.ctx, width: 360, height: 280, t, colors, still });
    }
    return rec;
  }

  it('draws every person, and the viewer in the accent colour with a halo', () => {
    const rec = draw([0], [0.5]);
    const dots = rec.arcs.filter(a => a.alpha === 0.5 || a.alpha === 1);
    expect(dots.length).toBe(13);
    expect(rec.arcs.filter(a => a.fill === 'ACCENT' && a.alpha === 1)).toHaveLength(1);
    expect(rec.arcs.some(a => a.fill === 'ACCENT' && a.alpha === 0.18)).toBe(true);
  });

  it('lights up recent activity over time, and nothing with motion turned off', () => {
    const moving = draw(undefined, [0, 0.6, 1.3, 1.6]);
    expect(moving.arcs.some(a => a.r > 3 && a.r < 17 && a.fill === 'ACCENT')).toBe(true);
    const still = draw(undefined, [0, 1.3, 1.6], true);
    expect(still.arcs.filter(a => a.fill === 'ACCENT')).toHaveLength(0);
    // Still: links shown steadily rather than fading.
    expect(still.lines.every(alpha => alpha === 0.35 * 0.3)).toBe(true);
  });
});

describe('the canvas loop every graph shares', () => {
  let frames: Array<(ms: number) => void>;
  let sight: (entries: Array<{ isIntersecting: boolean }>) => void;
  let reduced: boolean;
  let hidden: boolean;

  beforeEach(() => {
    frames = [];
    reduced = false;
    hidden = false;
    sight = () => {};
    vi.stubGlobal('requestAnimationFrame', (f: (ms: number) => void) => {
      frames.push(f);
      return frames.length;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {
      frames = [];
    });
    vi.stubGlobal('matchMedia', (q: string) => ({
      matches: q.includes('reduced-motion') && reduced,
      addEventListener() {},
      removeEventListener() {},
    }));
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(cb: typeof sight) {
          sight = cb;
        }
        observe() {}
        disconnect() {}
      },
    );
    vi.stubGlobal('getComputedStyle', () => ({
      getPropertyValue: (n: string) => (n === '--accent' ? ' #5856d6 ' : ' #000 '),
    }));
    vi.stubGlobal('document', {
      get hidden() {
        return hidden;
      },
      documentElement: {},
      addEventListener() {},
      removeEventListener() {},
    });
    vi.stubGlobal('window', { devicePixelRatio: 3 });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function canvas() {
    const rec = recorder();
    const el = {
      width: 0,
      height: 0,
      getContext: () => rec.ctx,
      getBoundingClientRect: () => ({ width: 300, height: 150 }),
    };
    return { el: el as unknown as HTMLCanvasElement, rec };
  }

  it('draws sharp (pixel ratio, at most 2), with the theme’s colours, and keeps drawing while visible', () => {
    const { el } = canvas();
    const seen: Frame[] = [];
    const stop = runCanvas(el, {
      resize() {},
      draw(f) {
        seen.push(f);
      },
    });
    expect([el.width, el.height]).toEqual([600, 300]);
    expect(seen[0]?.colors).toEqual({ ink: '#000', accent: '#5856d6' });
    expect(frames.length).toBe(1);
    stop();
    expect(frames.length).toBe(0);
  });

  it('draws once and stops when motion is turned off, the tab is hidden, or it’s scrolled away', () => {
    reduced = true;
    const one = canvas();
    const seen: number[] = [];
    runCanvas(one.el, {
      resize() {},
      draw(f) {
        seen.push(f.t);
      },
    });
    expect(frames).toHaveLength(0);
    expect(seen.every(t => t === 0)).toBe(true);

    reduced = false;
    hidden = true;
    runCanvas(canvas().el, { resize() {}, draw() {} });
    expect(frames).toHaveLength(0);

    hidden = false;
    runCanvas(canvas().el, { resize() {}, draw() {} });
    expect(frames).toHaveLength(1);
    sight([{ isIntersecting: false }]);
    expect(frames).toHaveLength(0);
  });
});
