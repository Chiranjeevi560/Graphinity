// The deploy step that makes one build into a site for one environment
// (docs/adr/0002-environments.md). The build holds no environment at all;
// this copies it untouched and writes only the files that name an
// environment: index.html (its settings and its own address), _headers
// (which servers the page may call), robots.txt and sitemap.xml. Every
// hashed script and style is the same bytes in staging and production.
import { cpSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pagesHeadersFile } from './headers.ts';
import { llmsTxt, robotsTxt, sitemapXml } from './seo.ts';
import type { SiteSettings } from './src/lib/settings.ts';

/** The files a stamp writes; everything else is the build, byte for byte. */
export const STAMPED_FILES = ['index.html', '_headers', 'robots.txt', 'sitemap.xml', 'llms.txt'] as const;

/** Addresses that would mean an environment slipped into the build itself. */
const ENVIRONMENT_TRACES =
  /https?:\/\/(localhost|127\.0\.0\.1)[:/]|\.pages\.dev|\.onrender\.com|\.supabase\.co|apps\.googleusercontent\.com/;

const escapeAttribute = (s: string) =>
  s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

/** index.html for one environment. Refuses a page already stamped, or one with an unknown placeholder. */
export function stampIndexHtml(html: string, settings: SiteSettings): string {
  if (!html.includes('%GRAPHINITY_SETTINGS%'))
    throw new Error('index.html has no %GRAPHINITY_SETTINGS% placeholder: was it stamped already?');
  const out = html
    .replaceAll('%GRAPHINITY_SETTINGS%', escapeAttribute(JSON.stringify(settings)))
    // An origin checked by settingsProblems: letters, digits, dots, colons and slashes only.
    .replaceAll('%SITE_ORIGIN%', settings.siteOrigin);
  const left = /%[A-Z_]+%/.exec(out);
  if (left) throw new Error(`index.html still has the placeholder ${left[0]}`);
  return out;
}

function files(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

/** Throws if the build itself names any environment: then it couldn't be promoted unchanged. */
export function assertNeutral(dist: string): void {
  for (const path of files(dist)) {
    if (!/\.(js|css|html|json|txt|xml|webmanifest)$/.test(path)) continue;
    const hit = ENVIRONMENT_TRACES.exec(readFileSync(path, 'utf8'));
    if (hit)
      throw new Error(
        `The build names an environment (${hit[0]}) in ${relative(dist, path)}: settings belong in the stamp, not the build.`,
      );
  }
}

/** Copies the build to `out` and writes the environment's files there. `dist` is never changed. */
export function stampDist(
  dist: string,
  out: string,
  settings: SiteSettings,
  options: { localHttp?: boolean } = {},
): void {
  if (!existsSync(join(dist, 'index.html'))) throw new Error(`No build in ${dist}: run the build first.`);
  assertNeutral(dist);
  cpSync(dist, out, { recursive: true, force: true });
  writeFileSync(join(out, 'index.html'), stampIndexHtml(readFileSync(join(dist, 'index.html'), 'utf8'), settings));
  writeFileSync(
    join(out, '_headers'),
    pagesHeadersFile({
      connectSrc: [settings.apiOrigin, settings.supabaseUrl],
      ...(options.localHttp ? { localHttp: true } : {}),
    }),
  );
  writeFileSync(join(out, 'robots.txt'), robotsTxt(settings.siteOrigin));
  writeFileSync(join(out, 'sitemap.xml'), sitemapXml(settings.siteOrigin));
  writeFileSync(join(out, 'llms.txt'), llmsTxt(settings.siteOrigin));
}
