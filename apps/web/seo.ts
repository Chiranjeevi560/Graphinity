// robots.txt and sitemap.xml, built from the site's origin so the addresses
// in them are always the ones the site is served from.

/** Screens that are personal or transient: nothing there for search. */
const PRIVATE_PATHS = ['/auth/', '/welcome', '/me', '/goodbye', '/ask'];

/** Pages to list for search engines. Questions join this list in step 3. */
const PUBLIC_PATHS = ['/'];

export function robotsTxt(origin: string): string {
  return [
    'User-agent: *',
    ...PRIVATE_PATHS.map(p => `Disallow: ${p}`),
    '',
    `Sitemap: ${new URL('/sitemap.xml', origin).toString()}`,
    '',
  ].join('\n');
}

export function sitemapXml(origin: string): string {
  const urls = PUBLIC_PATHS.map(p => `  <url><loc>${escapeXml(new URL(p, origin).toString())}</loc></url>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c] ?? c);
}
