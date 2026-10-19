import { describe, expect, it, vi } from 'vitest';
import { robotsTxt, sitemapXml } from '../seo.ts';
import { applyMeta, pageMeta } from '../src/lib/meta.ts';

const ORIGIN = 'https://graphinity.pages.dev';

describe('robots.txt and sitemap', () => {
  it('keeps personal screens out of crawling and points at the sitemap', () => {
    const robots = robotsTxt(ORIGIN);
    for (const p of ['/auth/', '/welcome', '/me', '/goodbye', '/ask', '/review'])
      expect(robots).toContain(`Disallow: ${p}\n`);
    expect(robots).not.toMatch(/^Disallow: \/$/m);
    expect(robots).toContain(`Sitemap: ${ORIGIN}/sitemap.xml`);
  });

  it('lists the home page with an absolute address, as valid XML', () => {
    const xml = sitemapXml(ORIGIN);
    expect(xml).toContain(`<loc>${ORIGIN}/</loc>`);
    expect(xml).toContain(`<loc>${ORIGIN}/privacy</loc>`);
    expect(xml).toContain(`<loc>${ORIGIN}/terms</loc>`);
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

describe('setting the tags as people move between screens', () => {
  it('sets the tab title, whether to index, and the canonical address', () => {
    const tags: Record<string, Record<string, string>> = { 'meta[name="robots"]': {}, 'link[rel="canonical"]': {} };
    const doc = {
      title: '',
      querySelector: (selector: string) => {
        const attrs = tags[selector];
        return attrs
          ? {
              setAttribute: (k: string, v: string) => {
                attrs[k] = v;
              },
            }
          : null;
      },
    };
    vi.stubGlobal('document', doc);
    applyMeta({ title: 'Ask – Graphinity', index: false }, '/ask', 'https://graphinity.pages.dev');
    expect(doc.title).toBe('Ask – Graphinity');
    expect(tags['meta[name="robots"]']).toEqual({ content: 'noindex' });
    expect(tags['link[rel="canonical"]']).toEqual({ href: 'https://graphinity.pages.dev/ask' });
    applyMeta(pageMeta('/'), '/', 'https://graphinity.pages.dev');
    expect(tags['meta[name="robots"]']).toEqual({ content: 'index, follow, max-image-preview:large' });
    vi.unstubAllGlobals();
  });
});
