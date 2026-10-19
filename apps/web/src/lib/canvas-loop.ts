// What every graph on the site needs from its canvas, done once: sharp on
// any screen, colours from the design tokens (light and dark), redrawn on
// resize, at most 30 frames a second, no frames at all when the tab is
// hidden or the canvas is scrolled away, and a single still frame for
// people who ask for less motion.

export interface Palette { ink: string; accent: string }
export interface Frame {
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
  /** Seconds since the loop started; the same value every frame when still. */
  t: number;
  colors: Palette;
  /** Reduced motion: draw the settled state. */
  still: boolean;
}

export interface CanvasScene {
  /** The canvas changed size (CSS pixels): recompute positions. */
  resize(width: number, height: number): void;
  draw(frame: Frame): void;
}

export function runCanvas(canvas: HTMLCanvasElement, scene: CanvasScene): () => void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return () => {};
  const still = matchMedia('(prefers-reduced-motion: reduce)');
  const scheme = matchMedia('(prefers-color-scheme: dark)');
  const started = performance.now();
  let width = 0;
  let height = 0;
  let colors = readColors();
  let frame = 0;
  let visible = true;
  let last = -Infinity;

  const now = () => (still.matches ? 0 : (performance.now() - started) / 1000);
  const draw = () => {
    ctx.clearRect(0, 0, width, height);
    scene.draw({ ctx, width, height, t: now(), colors, still: still.matches });
    ctx.globalAlpha = 1;
  };
  const tick = (ms: number) => {
    frame = requestAnimationFrame(tick);
    // The motion is slow: 30 frames a second look the same and cost half.
    if (ms - last < 1000 / 31) return;
    last = ms;
    draw();
  };
  const run = () => {
    cancelAnimationFrame(frame);
    draw();
    if (!still.matches && visible && !document.hidden) frame = requestAnimationFrame(tick);
  };
  const resize = () => {
    const box = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = box.width;
    height = box.height;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    scene.resize(width, height);
    draw();
  };
  const recolor = () => { colors = readColors(); draw(); };

  const sizeWatch = new ResizeObserver(resize);
  sizeWatch.observe(canvas);
  const sight = new IntersectionObserver(entries => { visible = entries.some(e => e.isIntersecting); run(); });
  sight.observe(canvas);
  scheme.addEventListener('change', recolor);
  still.addEventListener('change', run);
  document.addEventListener('visibilitychange', run);
  resize();
  run();
  return () => {
    cancelAnimationFrame(frame);
    sizeWatch.disconnect();
    sight.disconnect();
    scheme.removeEventListener('change', recolor);
    still.removeEventListener('change', run);
    document.removeEventListener('visibilitychange', run);
  };
}

/** The theme's colours, read from the design tokens. */
function readColors(): Palette {
  const style = getComputedStyle(document.documentElement);
  // Fallbacks only for a page without the stylesheet: the spec's light values.
  return { ink: style.getPropertyValue('--label').trim() || 'oklch(0.165 0.012 255)', accent: style.getPropertyValue('--accent').trim() || 'oklch(0.55 0.195 252)' };
}
