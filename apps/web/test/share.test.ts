import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { questionHead, questionPage, sitemap, type ShareEnv } from '../share.ts';

const SITE = 'https://graphinity.pages.dev';
// The real page head, as the build makes it.
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8').replaceAll('%SITE_ORIGIN%', SITE);
const question = { id: '42', title: 'How do I import a watch into the UAE?', body: 'Bought in Geneva.\nShipping to Dubai.', field: { name: 'Imports & Customs' }, answerCount: 2 };

const env: ShareEnv = {
  ASSETS: { fetch: (r: Request) => Promise.resolve(new Response(new URL(r.url).pathname === '/sitemap.xml' ? 'STATIC SITEMAP' : html, { headers: { 'content-type': 'text/html' } })) },
  VITE_API_ORIGIN: 'https://api.example', VITE_SUPABASE_URL: 'https://abcd.supabase.co', VITE_SITE_ORIGIN: SITE,
};
const api = (answer: (url: string) => Response | Promise<Response>) => ((url: string) => Promise.resolve(answer(url))) as unknown as typeof fetch;

describe('a question’s page head', () => {
  it('names the question for search engines and chat apps', () => {
    const out = questionHead(html, question, SITE);
    expect(out).toContain('<title>How do I import a watch into the UAE? – Graphinity</title>');
    expect(out).toContain('<meta name="description" content="Bought in Geneva. Shipping to Dubai.">');
    expect(out).toContain('<meta property="og:title" content="How do I import a watch into the UAE?">');
    expect(out).toContain(`<meta property="og:url" content="${SITE}/q/42/how-do-i-import-a-watch-into-the-uae">`);
    expect(out).toContain(`<link rel="canonical" href="${SITE}/q/42/how-do-i-import-a-watch-into-the-uae">`);
    expect(out).toContain('<meta property="og:type" content="article">');
  });

  it('takes titles literally, even ones with $ signs in them', () => {
    const out = questionHead(html, { ...question, title: "Is it $' or $& in the price?" }, SITE);
    expect(out).toContain("<title>Is it $&#39; or $&amp; in the price? – Graphinity</title>");
    expect(out.match(/<title>/g)).toHaveLength(1);
  });

  it('escapes everything it inserts', () => {
    const out = questionHead(html, { ...question, title: '"><script>alert(1)</script>', body: '<img src=x onerror=alert(1)>' }, SITE);
    expect(out).not.toContain('<script>alert');
    expect(out).not.toContain('<img src=x');
    expect(out).toContain('&lt;script&gt;');
  });

  it('describes a question without details by its answers and field, and shortens long details at a word', () => {
    expect(questionHead(html, { ...question, body: '' }, SITE)).toContain('content="2 answers from people who know Imports &amp; Customs.');
    const long = questionHead(html, { ...question, body: 'word '.repeat(100) }, SITE);
    const description = /<meta name="description" content="([^"]*)">/.exec(long)?.[1] ?? '';
    expect(description.length).toBeLessThanOrEqual(160);
    expect(description.endsWith('word…')).toBe(true);
  });
});

describe('the question page function', () => {
  it('serves the page with the question’s head and the site’s security headers', async () => {
    const res = await questionPage(new Request(`${SITE}/q/42/old-slug`), env, api(url => {
      expect(url).toBe('https://api.example/questions/42');
      return Response.json({ question });
    }));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<title>How do I import a watch into the UAE? – Graphinity</title>');
    expect(res.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(res.headers.get('content-security-policy')).toContain('https://api.example');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });

  it('falls back to the plain page for a bad id, a missing question or an API that is down', async () => {
    const plain = async (url: string, fetchFn: typeof fetch) => {
      const res = await questionPage(new Request(url), env, fetchFn);
      // Even the plain page carries the site's security headers.
      expect(res.headers.get('content-security-policy')).toContain("script-src 'self'");
      return (await res.text()) === html;
    };
    let calls = 0;
    expect(await plain(`${SITE}/q/abc`, api(() => { calls++; return Response.json({}); }))).toBe(true);
    expect(calls).toBe(0);
    expect(await plain(`${SITE}/q/7`, api(() => new Response(null, { status: 404 })))).toBe(true);
    expect(await plain(`${SITE}/q/7`, () => Promise.reject(new TypeError('down')))).toBe(true);
  });
});

describe('the sitemap function', () => {
  it('lists the fixed pages and the newest questions', async () => {
    const res = await sitemap(new Request(`${SITE}/sitemap.xml`), env, api(() => Response.json({ questions: [{ id: '42', title: question.title, createdAt: '2026-10-18T10:00:00.000Z' }] })));
    const xml = await res.text();
    expect(res.headers.get('content-type')).toBe('application/xml; charset=utf-8');
    expect(xml).toContain(`<loc>${SITE}/</loc>`);
    expect(xml).toContain(`<url><loc>${SITE}/q/42/how-do-i-import-a-watch-into-the-uae</loc><lastmod>2026-10-18</lastmod></url>`);
  });

  it('serves the built sitemap if the API can’t answer', async () => {
    expect(await (await sitemap(new Request(`${SITE}/sitemap.xml`), env, api(() => new Response(null, { status: 503 })))).text()).toBe('STATIC SITEMAP');
  });
});
