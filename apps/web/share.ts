// What a link to one question shows before any script runs: its own title
// and description for search engines and chat apps (which don't run the
// page). Used by the Cloudflare Pages Functions in /functions; kept here,
// pure and tested, so the logic runs under our tests, not only at the host.
import { securityHeaders } from './headers.ts';
import { sitemapXml } from './seo.ts';
import { questionPath } from './src/lib/questions.ts';

export interface ShareEnv {
  /** The static site, as built. */
  ASSETS: { fetch(request: Request): Promise<Response> };
  VITE_API_ORIGIN: string;
  VITE_SUPABASE_URL: string;
  VITE_SITE_ORIGIN: string;
}

interface Question { id: string; title: string; body: string; field: { name: string }; answerCount: number }

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

/** Up to 160 characters, cut at a word, with an ellipsis when cut. */
function shorten(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), max / 2))}…`;
}

/** The page's head with this question's title, description and address. Everything inserted is escaped. */
export function questionHead(html: string, q: Question, siteOrigin: string): string {
  const url = new URL(questionPath(q), siteOrigin).toString();
  const title = escapeHtml(`${q.title} – Graphinity`);
  const answers = q.answerCount === 1 ? '1 answer' : `${String(q.answerCount)} answers`;
  const description = escapeHtml(shorten(q.body || `${answers} from people who know ${q.field.name}. Ask once, reach people who’ve done it.`));
  const setMeta = (doc: string, attr: 'name' | 'property', key: string, value: string) =>
    doc.replace(new RegExp(`(<meta ${attr}="${key}" content=")[^"]*(")`), `$1${value}$2`);
  let out = html.replace(/<title>[^<]*<\/title>/, `<title>${title}</title>`);
  out = setMeta(out, 'name', 'description', description);
  out = setMeta(out, 'property', 'og:title', escapeHtml(q.title));
  out = setMeta(out, 'property', 'og:description', description);
  out = setMeta(out, 'property', 'og:url', escapeHtml(url));
  out = setMeta(out, 'property', 'og:type', 'article');
  out = out.replace(/(<link rel="canonical" href=")[^"]*(")/, `$1${escapeHtml(url)}$2`);
  return out;
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
  const page = await env.ASSETS.fetch(new Request(new URL('/', request.url)));
  const id = /^\/q\/([1-9][0-9]{0,15})(?:\/|$)/.exec(new URL(request.url).pathname)?.[1];
  if (!id || !page.ok) return page;
  let question: Question;
  try {
    const res = await fetchFn(`${env.VITE_API_ORIGIN}/questions/${id}`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return page;
    question = (await res.json() as { question: Question }).question;
  } catch {
    return page;
  }
  return new Response(questionHead(await page.text(), question, env.VITE_SITE_ORIGIN), { status: 200, headers: headersFor(env) });
}

/** /sitemap.xml: the fixed pages plus the newest questions; the built file if the API can't answer. */
export async function sitemap(request: Request, env: ShareEnv, fetchFn: typeof fetch): Promise<Response> {
  try {
    const res = await fetchFn(`${env.VITE_API_ORIGIN}/sitemap/questions`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return await env.ASSETS.fetch(request);
    const { questions } = await res.json() as { questions: Array<{ id: string; title: string; createdAt: string }> };
    const xml = sitemapXml(env.VITE_SITE_ORIGIN, questions.map(q => ({ path: questionPath(q), lastmod: q.createdAt.slice(0, 10) })));
    return new Response(xml, { headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=3600' } });
  } catch {
    return await env.ASSETS.fetch(request);
  }
}
