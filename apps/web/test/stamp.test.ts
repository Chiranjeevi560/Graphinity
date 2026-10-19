import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SiteSettings } from '../src/lib/settings.ts';
import { assertNeutral, STAMPED_FILES, stampDist, stampIndexHtml } from '../stamp.ts';

const staging: SiteSettings = {
  apiOrigin: 'https://graphinity-api-staging.onrender.com', siteOrigin: 'https://graphinity-staging.pages.dev',
  supabaseUrl: 'https://stag.supabase.co', supabasePublishableKey: 'sb_publishable_staging',
  googleClientId: 'staging.apps.googleusercontent.com', googleAuthorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
};
const production: SiteSettings = { ...staging, apiOrigin: 'https://graphinity-api.onrender.com', siteOrigin: 'https://graphinity.pages.dev', supabaseUrl: 'https://prod.supabase.co', supabasePublishableKey: 'sb_publishable_production', googleClientId: 'production.apps.googleusercontent.com' };

const page = '<!doctype html><html><head><meta name="graphinity-settings" content="%GRAPHINITY_SETTINGS%"><link rel="canonical" href="%SITE_ORIGIN%/"></head><body><script type="module" src="/assets/index-abc.js"></script></body></html>';

/** A small build: a page and two hashed files, nothing that names an environment. */
function build(): string {
  const dir = mkdtempSync(join(tmpdir(), 'graphinity-build-'));
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'index.html'), page);
  writeFileSync(join(dir, 'assets', 'index-abc.js'), 'export const x = document.querySelector("meta");');
  writeFileSync(join(dir, 'assets', 'index-def.css'), 'body{margin:0}');
  writeFileSync(join(dir, '_routes.json'), '{"version":1,"include":["/q/*"],"exclude":[]}');
  return dir;
}

function hashes(dir: string): Map<string, string> {
  const walk = (d: string): string[] => readdirSync(d).flatMap(n => statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]);
  return new Map(walk(dir).map(p => [relative(dir, p), createHash('sha256').update(readFileSync(p)).digest('hex')]));
}

describe('one build, stamped for each environment', () => {
  it('differs between staging and production only in the files that name an environment', () => {
    const dist = build();
    const before = hashes(dist);
    const out = mkdtempSync(join(tmpdir(), 'graphinity-out-'));
    stampDist(dist, join(out, 'staging'), staging);
    stampDist(dist, join(out, 'production'), production);
    const a = hashes(join(out, 'staging'));
    const b = hashes(join(out, 'production'));
    expect([...a.keys()].sort()).toEqual([...b.keys()].sort());
    const differing = [...a.keys()].filter(k => a.get(k) !== b.get(k)).sort();
    expect(differing).toEqual([...STAMPED_FILES].sort());
    // The build itself is untouched, and every other file is it, byte for byte.
    expect(hashes(dist)).toEqual(before);
    for (const [k, h] of before) if (!(STAMPED_FILES as readonly string[]).includes(k)) expect(a.get(k)).toBe(h);
  });

  it('writes the settings and the site’s own address, escaped for the page', () => {
    const html = stampIndexHtml(page, { ...staging, supabasePublishableKey: 'sb_publishable_"<x>' });
    expect(html).toContain('href="https://graphinity-staging.pages.dev/"');
    expect(html).toContain('&quot;apiOrigin&quot;:&quot;https://graphinity-api-staging.onrender.com&quot;');
    expect(html).not.toContain('"<x>');
  });

  it('refuses to stamp twice, or to leave a placeholder unfilled', () => {
    const once = stampIndexHtml(page, staging);
    expect(() => stampIndexHtml(once, production)).toThrow(/stamped already/);
    expect(() => stampIndexHtml(`${page}<p>%NEW_THING%</p>`, staging)).toThrow(/%NEW_THING%/);
  });

  it('refuses a build that names an environment itself, so it could never be promoted unchanged', () => {
    const dist = build();
    expect(() => { assertNeutral(dist); }).not.toThrow();
    writeFileSync(join(dist, 'assets', 'index-abc.js'), 'fetch("http://localhost:3000/health")');
    expect(() => { assertNeutral(dist); }).toThrow(/localhost.*assets\/index-abc\.js/);
    writeFileSync(join(dist, 'assets', 'index-abc.js'), 'fetch("https://x.onrender.com")');
    expect(() => { stampDist(dist, mkdtempSync(join(tmpdir(), 'graphinity-out-')), staging); }).toThrow(/onrender/);
  });
});
