import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { questionBody, questionHead, questionPage, sitemap, type QuestionPage, type ShareEnv } from '../share.ts';

const SITE = 'https://graphinity.pages.dev';
// The real page head, as the build makes it.
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8').replaceAll('%SITE_ORIGIN%', SITE);
const question = {
  id: '42',
  title: 'How do I import a watch into the UAE?',
  body: 'Bought in Geneva.\nShipping to Dubai.',
  field: { name: 'Imports & Customs' },
  answerCount: 2,
  createdAt: '2026-10-19T04:00:00.000Z',
  asker: { handle: 'arjun' },
};
const page = (
  q: QuestionPage['question'] = question,
  answers: QuestionPage['answers'] = [],
  selection: QuestionPage['selection'] = null,
): QuestionPage => ({ question: q, answers, selection });
const answers = [
  {
    id: '7',
    body: 'Paid AED 1,200 at Dubai airport customs.',
    createdAt: '2026-10-19T05:00:00.000Z',
    answerer: { handle: 'vikram' },
  },
  {
    id: '8',
    body: 'Mine cleared with no duty under the allowance.',
    createdAt: '2026-10-19T06:00:00.000Z',
    answerer: { handle: 'sara' },
  },
];

const env: ShareEnv = {
  ASSETS: {
    fetch: (r: Request) =>
      Promise.resolve(
        new Response(new URL(r.url).pathname === '/sitemap.xml' ? 'STATIC SITEMAP' : html, {
          headers: { 'content-type': 'text/html' },
        }),
      ),
  },
  VITE_API_ORIGIN: 'https://api.example',
  VITE_SUPABASE_URL: 'https://abcd.supabase.co',
  VITE_SITE_ORIGIN: SITE,
};
const api = (answer: (url: string) => Response | Promise<Response>) =>
  ((url: string) => Promise.resolve(answer(url))) as unknown as typeof fetch;

describe('a question’s page head', () => {
  it('names the question for search engines and chat apps', () => {
    const out = questionHead(html, page(), SITE);
    expect(out).toContain('<title>How do I import a watch into the UAE? – Graphinity</title>');
    expect(out).toContain('<meta name="description" content="Bought in Geneva. Shipping to Dubai.">');
    expect(out).toContain('<meta property="og:title" content="How do I import a watch into the UAE?">');
    expect(out).toContain(`<meta property="og:url" content="${SITE}/q/42/how-do-i-import-a-watch-into-the-uae">`);
    expect(out).toContain(`<link rel="canonical" href="${SITE}/q/42/how-do-i-import-a-watch-into-the-uae">`);
    expect(out).toContain('<meta property="og:type" content="article">');
  });

  it('takes titles literally, even ones with $ signs in them', () => {
    const out = questionHead(html, page({ ...question, title: "Is it $' or $& in the price?" }), SITE);
    expect(out).toContain('<title>Is it $&#39; or $&amp; in the price? – Graphinity</title>');
    expect(out.match(/<title>/g)).toHaveLength(1);
  });

  it('escapes everything it inserts', () => {
    const out = questionHead(
      html,
      page({ ...question, title: '"><script>alert(1)</script>', body: '<img src=x onerror=alert(1)>' }),
      SITE,
    );
    expect(out).not.toContain('<script>alert');
    expect(out).not.toContain('<img src=x');
    expect(out).toContain('&lt;script&gt;');
  });

  it('describes a question without details by its answers and field, and shortens long details at a word', () => {
    expect(questionHead(html, page({ ...question, body: '' }), SITE)).toContain(
      'content="2 answers from people who know Imports &amp; Customs.',
    );
    const long = questionHead(html, page({ ...question, body: 'word '.repeat(100) }), SITE);
    const description = /<meta name="description" content="([^"]*)">/.exec(long)?.[1] ?? '';
    expect(description.length).toBeLessThanOrEqual(160);
    expect(description.endsWith('word…')).toBe(true);
  });
});

/** The QAPage data block in a page, if any (the site's own WebSite block is always there too). */
function qaPage(out: string): string | undefined {
  return [...out.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/gs)]
    .map(m => m[1] ?? '')
    .find(j => j.includes('"QAPage"'));
}

describe('search engines (spec §19)', () => {
  it('keep an unanswered question out of results until someone answers', () => {
    const out = questionHead(html, page(), SITE);
    expect(out).toContain('<meta name="robots" content="noindex, follow">');
    expect(qaPage(out)).toBeUndefined();
  });

  it('read an answered question as a QAPage: the pick accepted, the others suggested, each linked', () => {
    const out = questionHead(html, page(question, answers, { answerId: '8' }), SITE);
    expect(out).toContain('<meta name="robots" content="index, follow, max-image-preview:large">');
    const data = JSON.parse(qaPage(out) ?? '') as {
      '@type': string;
      mainEntity: {
        name: string;
        answerCount: number;
        author: { name: string };
        acceptedAnswer: { text: string; url: string };
        suggestedAnswer: Array<{ text: string }>;
      };
    };
    expect(data['@type']).toBe('QAPage');
    expect(data.mainEntity).toMatchObject({ name: question.title, answerCount: 2, author: { name: 'arjun' } });
    expect(data.mainEntity.acceptedAnswer).toMatchObject({
      text: 'Mine cleared with no duty under the allowance.',
      url: `${SITE}/q/42/how-do-i-import-a-watch-into-the-uae#answer-8`,
    });
    expect(data.mainEntity.suggestedAnswer.map(a => a.text)).toEqual(['Paid AED 1,200 at Dubai airport customs.']);
  });

  it('never count hidden answers, and no answer text can end the data block', () => {
    const hostile = [
      {
        ...(answers[0] ?? answers[1]),
        id: '9',
        body: 'nice </script><script>alert(1)</script>',
        answerer: { handle: 'x' },
      },
      { ...(answers[1] ?? answers[0]), id: '10', hidden: true, answerer: { handle: 'y' } },
    ];
    const out = questionHead(html, page(question, hostile as QuestionPage['answers']), SITE);
    expect(out).not.toContain('</script><script>alert');
    expect(
      (
        JSON.parse(qaPage(out) ?? '') as {
          mainEntity: { answerCount: number; suggestedAnswer: Array<{ text: string }> };
        }
      ).mainEntity,
    ).toMatchObject({ answerCount: 1, suggestedAnswer: [{ text: 'nice </script><script>alert(1)</script>' }] });
    expect(
      questionHead(html, page(question, [{ ...hostile[1], hidden: true } as QuestionPage['answers'][number]]), SITE),
    ).toContain('noindex, follow');
  });
});

describe('the question page function', () => {
  it('serves the page with the question’s head and the site’s security headers', async () => {
    const res = await questionPage(
      new Request(`${SITE}/q/42/old-slug`),
      env,
      api(url => {
        expect(url).toBe('https://api.example/questions/42');
        return Response.json(page());
      }),
    );
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
    expect(
      await plain(
        `${SITE}/q/abc`,
        api(() => {
          calls++;
          return Response.json({});
        }),
      ),
    ).toBe(true);
    expect(calls).toBe(0);
    expect(
      await plain(
        `${SITE}/q/7`,
        api(() => new Response(null, { status: 404 })),
      ),
    ).toBe(true);
    expect(await plain(`${SITE}/q/7`, () => Promise.reject(new TypeError('down')))).toBe(true);
  });
});

describe('the sitemap function', () => {
  it('lists the fixed pages and the newest questions', async () => {
    const res = await sitemap(
      new Request(`${SITE}/sitemap.xml`),
      env,
      api(() =>
        Response.json({ questions: [{ id: '42', title: question.title, createdAt: '2026-10-18T10:00:00.000Z' }] }),
      ),
    );
    const xml = await res.text();
    expect(res.headers.get('content-type')).toBe('application/xml; charset=utf-8');
    expect(xml).toContain(`<loc>${SITE}/</loc>`);
    expect(xml).toContain(
      `<url><loc>${SITE}/q/42/how-do-i-import-a-watch-into-the-uae</loc><lastmod>2026-10-18</lastmod></url>`,
    );
  });

  it('serves the built sitemap if the API can’t answer', async () => {
    expect(
      await (
        await sitemap(
          new Request(`${SITE}/sitemap.xml`),
          env,
          api(() => new Response(null, { status: 503 })),
        )
      ).text(),
    ).toBe('STATIC SITEMAP');
  });
});

describe('the question, readable before any script runs (for crawlers that never run one)', () => {
  const agreeing: QuestionPage = {
    ...page(question, answers, { answerId: '8' }),
    consensus: {
      confidence: 0.55,
      clusters: [
        { currency: 'AED', lowMinor: 120000, highMinor: 125000, share: 0.67, answers: 2 },
        { currency: 'AED', lowMinor: 0, highMinor: 0, share: 0.33, answers: 1 },
      ],
    },
  };

  it('fills the page with the question, the answers in order, and the asker’s pick', () => {
    const out = questionHead(html, agreeing, SITE);
    const root = /<div id="root">([\s\S]*?)<\/div>\s*<\/body>|<div id="root">([\s\S]*)/.exec(out)?.[0] ?? '';
    expect(root).toContain('<h1>How do I import a watch into the UAE?</h1>');
    expect(root).toContain('<p>Bought in Geneva.<br>Shipping to Dubai.</p>');
    expect(root.indexOf('answer-7')).toBeLessThan(root.indexOf('answer-8'));
    expect(root).toMatch(/<li id="answer-8"><p><strong>Picked by the asker/);
    expect(root).not.toMatch(/<li id="answer-7"><p><strong>Picked/);
    expect(root).toContain('@vikram');
    expect(root).toContain('<h2>2 answers</h2>');
  });

  it('says how far the answers agree, in words, and uses that as the description', () => {
    const out = questionHead(html, agreeing, SITE);
    expect(out).toContain('<h2>What the answers report</h2><p>People partly agree: ');
    expect(/<meta name="description" content="([^"]*)"/.exec(out)?.[1]).toMatch(/^People partly agree: /);
  });

  it('leaves out hidden answers, and keeps hostile text as text', () => {
    const body = questionBody(
      page({ ...question, title: '<img src=x onerror=alert(1)>' }, [
        { id: '9', body: '</div><script>alert(1)</script>', createdAt: question.createdAt, answerer: { handle: 'x' } },
        { id: '10', body: 'Hidden one', createdAt: question.createdAt, answerer: { handle: 'y' }, hidden: true },
      ]),
    );
    expect(body).not.toMatch(/<script|<img/);
    expect(body).toContain('&lt;/div&gt;&lt;script&gt;');
    expect(body).not.toContain('Hidden one');
    expect(body).toContain('<h2>1 answer</h2>');
  });

  it('says so when there are no answers yet', () => {
    expect(questionBody(page())).toContain('<h2>0 answers</h2><p>No answers yet.</p>');
  });
});
