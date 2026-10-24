// What a link to one question shows before any script runs: its own title
// and description for search engines and chat apps (which don't run the
// page). Used by the Cloudflare Pages Functions in apps/web/functions; kept here,
// pure and tested, so the logic runs under our tests, not only at the host.
import { securityHeaders } from './headers.ts';
import { sitemapXml } from './seo.ts';
import { consensusSentence, questionPath, type Consensus } from './src/lib/questions.ts';

export interface ShareEnv {
  /** The static site, as built. */
  ASSETS: { fetch(request: Request): Promise<Response> };
  VITE_API_ORIGIN: string;
  VITE_SUPABASE_URL: string;
  VITE_SITE_ORIGIN: string;
}

interface Question {
  id: string;
  title: string;
  body: string;
  field: { name: string };
  answerCount: number;
  createdAt: string;
  asker: { handle: string };
}
interface PageAnswer {
  id: string;
  body: string;
  createdAt: string;
  answerer: { handle: string };
  hidden?: boolean;
}
/** What /questions/:id returns that the head needs. */
export interface QuestionPage {
  question: Question;
  answers: PageAnswer[];
  selection: { answerId: string | null } | null;
  /** How far the answers' amounts agree, once 3 report one. */
  consensus?: Consensus | null;
}

/** Suggested answers listed for search engines besides the accepted one (Google reads a few). */
const SUGGESTED_MAX = 5;

/**
 * Schema.org QAPage (docs/SPEC.md §19.1): the question, the
 * answer the asker picked as acceptedAnswer, the others as suggestedAnswer,
 * each linked to its place on the page. Only for a question with an answer.
 * "<" is written as \u003c, so no answer text can end the script element.
 */
export function qaPageJson(page: QuestionPage, url: string): string | null {
  const visible = page.answers.filter(a => !a.hidden);
  if (visible.length === 0) return null;
  const answer = (a: PageAnswer) => ({
    '@type': 'Answer',
    text: a.body,
    dateCreated: a.createdAt,
    url: `${url}#answer-${a.id}`,
    author: { '@type': 'Person', name: a.answerer.handle },
  });
  const accepted = visible.find(a => a.id === page.selection?.answerId);
  const data = {
    '@context': 'https://schema.org',
    '@type': 'QAPage',
    mainEntity: {
      '@type': 'Question',
      name: page.question.title,
      ...(page.question.body ? { text: page.question.body } : {}),
      answerCount: visible.length,
      dateCreated: page.question.createdAt,
      author: { '@type': 'Person', name: page.question.asker.handle },
      about: { '@type': 'Thing', name: page.question.field.name },
      ...(accepted ? { acceptedAnswer: answer(accepted) } : {}),
      suggestedAnswer: visible
        .filter(a => a !== accepted)
        .slice(0, SUGGESTED_MAX)
        .map(answer),
    },
  };
  return JSON.stringify(data).replace(/</g, '\\u003c');
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

/** Up to 160 characters, cut at a word, with an ellipsis when cut. */
function shorten(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), max / 2))}…`;
}

/**
 * The page's head with this question's title, description and address, and
 * for an answered question its QAPage data; an unanswered one is kept out
 * of search results until it has an answer (spec §19.2). Everything
 * inserted is escaped.
 */
export function questionHead(html: string, page: QuestionPage, siteOrigin: string): string {
  const q = page.question;
  const url = new URL(questionPath(q), siteOrigin).toString();
  const title = escapeHtml(`${q.title} – Graphinity`);
  const answers = q.answerCount === 1 ? '1 answer' : `${String(q.answerCount)} answers`;
  // Where the answers agree on an amount, that is the line worth quoting.
  const agreement = page.consensus ? consensusSentence(page.consensus) : '';
  const description = escapeHtml(
    shorten(
      agreement || q.body || `${answers} from people who know ${q.field.name}. Ask once, reach people who’ve done it.`,
    ),
  );
  const setMeta = (doc: string, attr: 'name' | 'property', key: string, value: string) =>
    doc.replace(
      new RegExp(`(<meta ${attr}="${key}" content=")[^"]*(")`),
      (_m, open: string, close: string) => `${open}${value}${close}`,
    );
  // Replacements are functions so a title like "$'" is taken literally.
  let out = html.replace(/<title>[^<]*<\/title>/, () => `<title>${title}</title>`);
  out = setMeta(out, 'name', 'description', description);
  out = setMeta(out, 'property', 'og:title', escapeHtml(q.title));
  out = setMeta(out, 'property', 'og:description', description);
  out = setMeta(out, 'property', 'og:url', escapeHtml(url));
  out = setMeta(out, 'property', 'og:type', 'article');
  out = out.replace(
    /(<link rel="canonical" href=")[^"]*(")/,
    (_m, open: string, close: string) => `${open}${escapeHtml(url)}${close}`,
  );
  const json = qaPageJson(page, url);
  out = setMeta(out, 'name', 'robots', json ? 'index, follow, max-image-preview:large' : 'noindex, follow');
  if (json) out = out.replace('</head>', () => `<script type="application/ld+json">${json}</script>\n</head>`);
  // The question itself, readable without running the app: most AI
  // assistants' crawlers never run scripts, so without this they would see
  // an empty page. The app replaces it when it starts (createRoot).
  out = out.replace('<div id="root"></div>', () => `<div id="root">${questionBody(page)}</div>`);
  return out;
}

/** Most answers written into the page before the app starts; the app shows the rest. */
const BODY_ANSWERS_MAX = 50;

const paragraphs = (text: string) =>
  text
    .split(/\n{2,}/)
    .map(p => p.trim())
    .filter(Boolean)
    .map(p => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('');

const dateOnly = (iso: string) => escapeHtml(iso.slice(0, 10));

/**
 * The question, how far its answers agree, and the visible answers, as
 * plain escaped HTML in the order the page shows them. Hidden answers never
 * appear; the one the asker picked says so.
 */
export function questionBody(page: QuestionPage): string {
  const q = page.question;
  const visible = page.answers.filter(a => !a.hidden);
  const picked = page.selection?.answerId ?? null;
  const agreement = page.consensus ? consensusSentence(page.consensus) : '';
  const answers = visible
    .slice(0, BODY_ANSWERS_MAX)
    .map(
      a =>
        `<li id="answer-${escapeHtml(a.id)}">${a.id === picked ? '<p><strong>Picked by the asker as the answer that helped</strong></p>' : ''}${paragraphs(a.body)}<p>@${escapeHtml(a.answerer.handle)} · <time datetime="${escapeHtml(a.createdAt)}">${dateOnly(a.createdAt)}</time></p></li>`,
    );
  const count = visible.length === 1 ? '1 answer' : `${String(visible.length)} answers`;
  return [
    '<main class="page"><article>',
    `<h1>${escapeHtml(q.title)}</h1>`,
    `<p>${escapeHtml(q.field.name)} · Asked by @${escapeHtml(q.asker.handle)} · <time datetime="${escapeHtml(q.createdAt)}">${dateOnly(q.createdAt)}</time></p>`,
    q.body ? paragraphs(q.body) : '',
    '</article>',
    agreement
      ? `<section aria-label="What the answers report"><h2>What the answers report</h2><p>${escapeHtml(agreement)}</p></section>`
      : '',
    `<section aria-label="${count}"><h2>${count}</h2>${answers.length ? `<ol>${answers.join('')}</ol>` : '<p>No answers yet.</p>'}</section>`,
    '</main>',
  ].join('');
}

function headersFor(env: ShareEnv): Headers {
  // The host doesn't apply the _headers file to Function responses: same policy, set here.
  const headers = new Headers(securityHeaders({ connectSrc: [env.VITE_API_ORIGIN, env.VITE_SUPABASE_URL] }));
  headers.set('content-type', 'text/html; charset=utf-8');
  headers.set('cache-control', 'no-cache');
  return headers;
}

/** /q/:id/…: the app's page, with this question in its head. Anything unexpected: the plain page. */
export async function questionPage(request: Request, env: ShareEnv, fetchFn: typeof fetch): Promise<Response> {
  const asset = await env.ASSETS.fetch(new Request(new URL('/', request.url)));
  if (!asset.ok) return asset;
  const html = await asset.text();
  // Even the plain page goes out with the site's security headers.
  const plain = () => new Response(html, { status: 200, headers: headersFor(env) });
  const id = /^\/q\/([1-9][0-9]{0,15})(?:\/|$)/.exec(new URL(request.url).pathname)?.[1];
  if (!id) return plain();
  let page: QuestionPage;
  try {
    // Long enough for a free server waking up; previews wait about this long.
    const res = await fetchFn(`${env.VITE_API_ORIGIN}/questions/${id}`, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return plain();
    page = (await res.json()) as QuestionPage;
  } catch {
    return plain();
  }
  return new Response(questionHead(html, page, env.VITE_SITE_ORIGIN), { status: 200, headers: headersFor(env) });
}

/** /sitemap.xml: the fixed pages plus the newest questions; the built file if the API can't answer. */
export async function sitemap(request: Request, env: ShareEnv, fetchFn: typeof fetch): Promise<Response> {
  try {
    const res = await fetchFn(`${env.VITE_API_ORIGIN}/sitemap/questions`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return await env.ASSETS.fetch(request);
    const { questions } = (await res.json()) as {
      questions: Array<{ id: string; title: string; createdAt: string; lastAnsweredAt?: string }>;
    };
    const xml = sitemapXml(
      env.VITE_SITE_ORIGIN,
      questions.map(q => ({ path: questionPath(q), lastmod: (q.lastAnsweredAt ?? q.createdAt).slice(0, 10) })),
    );
    return new Response(xml, {
      headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=3600' },
    });
  } catch {
    return await env.ASSETS.fetch(request);
  }
}
