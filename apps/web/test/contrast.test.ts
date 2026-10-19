// Every text colour against every background it can sit on, in light and
// dark, read straight from tokens.css. axe checks what is on screen; this also
// covers states axe never sees (hovered and pressed fills, the dialog panel).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../src/styles/tokens.css', import.meta.url), 'utf8');

type RGBA = [number, number, number, number];

function tokens(block: string): Record<string, string> {
  return Object.fromEntries([...block.matchAll(/--([\w-]+):\s*([^;]+);/g)].map(([, name = '', value = '']) => [name, value.trim()]));
}

const light = tokens(css.slice(css.indexOf(':root {'), css.indexOf('@media (min-resolution')));
const darkStart = css.indexOf('@media (prefers-color-scheme: dark)');
const dark = { ...light, ...tokens(css.slice(darkStart, css.indexOf('@media (prefers-reduced-motion'))) };

/**
 * OKLCH to sRGB (Björn Ottosson's OKLab matrices), gamma-encoded and clipped
 * to the screen's range, as browsers render it.
 */
function oklch(l: number, c: number, hDeg: number): [number, number, number] {
  const h = (hDeg * Math.PI) / 180;
  const a = c * Math.cos(h), b = c * Math.sin(h);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const linear = [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
  const encode = (x: number) => 255 * Math.min(1, Math.max(0, x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055));
  return [encode(linear[0] ?? 0), encode(linear[1] ?? 0), encode(linear[2] ?? 0)];
}

function parse(value: string): RGBA {
  const ok = /^oklch\(([\d.]+) ([\d.]+) ([\d.]+)(?: \/ ([\d.]+))?\)$/.exec(value);
  if (ok) return [...oklch(Number(ok[1]), Number(ok[2]), Number(ok[3])), ok[4] ? Number(ok[4]) : 1];
  const hex = /^#([0-9a-f]{6})$/i.exec(value)?.[1];
  if (hex) return [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16)).concat(1) as RGBA;
  const rgb = /^rgb\((\d+) (\d+) (\d+)(?: \/ ([\d.]+))?\)$/.exec(value);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), rgb[4] ? Number(rgb[4]) : 1];
  throw new Error(`unparsed colour ${value}`);
}

/** Paint layers bottom to top; returns the opaque colour the eye sees. */
function composite(base: RGBA, ...layers: RGBA[]): [number, number, number] {
  let out: [number, number, number] = [base[0], base[1], base[2]];
  for (const [r, g, b, a] of layers) out = [r * a + out[0] * (1 - a), g * a + out[1] * (1 - a), b * a + out[2] * (1 - a)];
  return out;
}

function luminance([r, g, b]: [number, number, number]): number {
  const lin = (c: number) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function ratio(a: [number, number, number], b: [number, number, number]): number {
  const lighter = Math.max(luminance(a), luminance(b));
  const darker = Math.min(luminance(a), luminance(b));
  return (lighter + 0.05) / (darker + 0.05);
}

/** Text colour token, and the stacks of background tokens it appears on. */
const pairs: Array<[string, string[][]]> = [
  ['label', [['bg'], ['bg-grouped'], ['surface'], ['surface-raised'], ['surface-raised', 'fill-tertiary'], ['bg', 'fill-tertiary'], ['surface-raised', 'fill-secondary']]],
  ['label-secondary', [['bg'], ['bg-grouped'], ['surface'], ['surface-raised'], ['bg', 'fill-tertiary'], ['surface-raised', 'fill-tertiary'], ['bg', 'fill-secondary'], ['surface-raised', 'fill-secondary']]],
  ['accent-text', [['bg'], ['bg-grouped'], ['surface'], ['surface-raised'], ['bg', 'fill-tertiary'], ['surface-raised', 'fill-tertiary'], ['bg', 'fill-secondary'], ['surface-raised', 'fill-secondary']]],
  ['green-text', [['bg'], ['surface'], ['surface-raised'], ['surface', 'green-tint']]],
  ['medal-gold', [['bg'], ['surface']]],
  ['medal-silver', [['bg'], ['surface']]],
  ['medal-bronze', [['bg'], ['surface']]],
  ['red-text', [['bg'], ['surface'], ['surface-raised']]],
  ['red-on-fill', [['bg', 'fill-tertiary'], ['surface-raised', 'fill-tertiary'], ['bg', 'fill-secondary'], ['surface-raised', 'fill-secondary']]],
  ['on-accent', [['accent']]],
  // Spec §6.1 names, checked directly as well as through the names above.
  ['text-primary', [['surface-canvas'], ['surface-card']]],
  ['text-secondary', [['surface-canvas'], ['surface-card']]],
  ['status-consensus', [['surface-canvas'], ['surface-card']]],
  ['status-variance-text', [['surface-canvas'], ['surface-card']]],
  ['status-danger', [['surface-canvas'], ['surface-card']]],
];

describe('reading OKLCH', () => {
  it('matches known sRGB values', () => {
    expect(oklch(1, 0, 0).map(Math.round)).toEqual([255, 255, 255]);
    expect(oklch(0, 0, 0).map(Math.round)).toEqual([0, 0, 0]);
    // sRGB red, #ff0000, is oklch(0.628 0.2577 29.23).
    expect(oklch(0.62796, 0.25768, 29.2339).map(Math.round)).toEqual([255, 0, 0]);
  });
});

describe.each([['light', light], ['dark', dark]] as const)('%s appearance', (_name, t) => {
  it.each(pairs)('%s text is at least 4.5:1 on every background it sits on', (text, stacks) => {
    // Follows var(--other) to the colour it names, as the browser does.
    const token = (k: string): RGBA => {
      const v = t[k];
      if (v === undefined) throw new Error(`no token --${k}`);
      const ref = /^var\(--([\w-]+)\)$/.exec(v)?.[1];
      return ref ? token(ref) : parse(v);
    };
    for (const [base = '', ...layers] of stacks) {
      const bg = composite(token(base), ...layers.map(token));
      const fg = composite([...bg, 1], token(text));
      const stack = [base, ...layers];
      expect(ratio(fg, bg), `${text} on ${stack.join(' + ')}`).toBeGreaterThanOrEqual(4.5);
    }
  });
});
