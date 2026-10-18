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

function parse(value: string): RGBA {
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
  ['green-text', [['bg'], ['surface'], ['surface-raised']]],
  ['medal-gold', [['bg'], ['surface']]],
  ['medal-silver', [['bg'], ['surface']]],
  ['medal-bronze', [['bg'], ['surface']]],
  ['red-text', [['bg'], ['surface'], ['surface-raised']]],
  ['red-on-fill', [['bg', 'fill-tertiary'], ['surface-raised', 'fill-tertiary'], ['bg', 'fill-secondary'], ['surface-raised', 'fill-secondary']]],
  ['on-accent', [['accent']]],
];

describe.each([['light', light], ['dark', dark]] as const)('%s appearance', (_name, t) => {
  it.each(pairs)('%s text is at least 4.5:1 on every background it sits on', (text, stacks) => {
    const token = (k: string) => {
      const v = t[k];
      if (v === undefined) throw new Error(`no token --${k}`);
      return parse(v);
    };
    for (const [base = '', ...layers] of stacks) {
      const bg = composite(token(base), ...layers.map(token));
      const fg = composite([...bg, 1], token(text));
      const stack = [base, ...layers];
      expect(ratio(fg, bg), `${text} on ${stack.join(' + ')}`).toBeGreaterThanOrEqual(4.5);
    }
  });
});
