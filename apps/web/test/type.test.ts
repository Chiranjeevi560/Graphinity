// Spec §5.2: letter-spacing follows Apple's optical curve, so tokens.css
// can't drift from it by hand.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../src/styles/tokens.css', import.meta.url), 'utf8');

describe('type tokens', () => {
  const styles = [...css.matchAll(/--text-([a-z0-9]+)-size: ([\d.]+)rem;[^]*?--text-\1-tracking: ([-\d.]+)em;/g)];

  it('cover every text style', () => {
    expect(styles.map(m => m[1])).toEqual(['large', 'title1', 'title2', 'title3', 'body', 'callout', 'subhead', 'footnote', 'caption']);
  });

  it.each(styles.map(m => [m[1] ?? '', Number(m[2]), Number(m[3])] as const))('%s tracks at -0.032 + 0.42/S em', (_name, rem, tracking) => {
    expect(tracking).toBeCloseTo(-0.032 + 0.42 / (rem * 16), 4);
  });
});
