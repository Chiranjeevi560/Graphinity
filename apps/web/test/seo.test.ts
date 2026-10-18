import { describe, expect, it } from 'vitest';
import { robotsTxt, sitemapXml } from '../seo.ts';
import { pageMeta } from '../src/lib/meta.ts';

const ORIGIN = 'https://graphinity.pages.dev';

describe('robots.txt and sitemap', () => {
  it('keeps personal screens out of crawling and points at the sitemap', () => {
    const robots = robotsTxt(ORIGIN);
    for (const p of ['/auth/', '/welcome', '/me', '/goodbye', '/ask', '/review']) expect(robots).toContain(`Disallow: ${p}\n`);
    expect(robots).not.toMatch(/^Disallow: \/$/m);
    expect(robots).toContain(`Sitemap: ${ORIGIN}/sitemap.xml`);
  });

  it('lists the home page with an absolute address, as valid XML', () => {
    const xml = sitemapXml(ORIGIN);
    expect(xml).toContain(`<loc>${ORIGIN}/</loc>`);
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
  });
});

describe('page titles and indexing', () => {
  it('lets search engines index only public pages', () => {
    expect(pageMeta('/')).toMatchObject({ index: true });
    for (const p of ['/welcome', '/me', '/me/edit', '/goodbye', '/auth/callback', '/u/someone', '/nope']) {
      expect(pageMeta(p).index, p).toBe(false);
    }
  });

  it('names each screen for the tab and search results', () => {
    expect(pageMeta('/').title).toBe('Graphinity: ask people who’ve actually done it');
    expect(pageMeta('/u/chiru').title).toBe('@chiru – Graphinity');
    expect(pageMeta('/u/%E0').title).toBe('@%E0 – Graphinity');
    expect(pageMeta('/nope').title).toBe('Page not found – Graphinity');
  });
});
