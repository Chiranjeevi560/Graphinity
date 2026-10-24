// robots.txt and sitemap.xml, built from the site's origin so the addresses
// in them are always the ones the site is served from.

/** Screens that are personal or transient: nothing there for search. */
const PRIVATE_PATHS = ['/auth/', '/welcome', '/me', '/goodbye', '/ask', '/review'];

/** Pages to list for search engines. Questions join this list in step 3. */
const PUBLIC_PATHS = ['/', '/privacy', '/terms'];

/**
 * AI assistants that search and cite (they link back to the question), by the
 * tokens their makers document (checked 2026-10-25: OpenAI, Anthropic,
 * Perplexity, Apple). They may read every public page, like search engines.
 */
export const CITING_CRAWLERS = [
  'OAI-SearchBot',
  'ChatGPT-User',
  'Claude-SearchBot',
  'Claude-User',
  'PerplexityBot',
  'Perplexity-User',
  'Applebot',
] as const;

/**
 * Crawlers whose only job is collecting text to train AI models, or tokens
 * that only govern that use. Answers are people's own first-hand reports and
 * they haven't agreed to model training, so these are refused. Refusing them
 * doesn't affect search: Google says Google-Extended "does not impact a site's
 * inclusion in Google Search", Apple the same of Applebot-Extended. The cost:
 * Google-Extended also covers Gemini answering from Search ("grounding").
 */
export const TRAINING_CRAWLERS = ['GPTBot', 'ClaudeBot', 'CCBot', 'Google-Extended', 'Applebot-Extended'] as const;

export function robotsTxt(origin: string): string {
  // A crawler named in a group follows only that group, so the private
  // screens are repeated for the named citing crawlers.
  const privateRules = PRIVATE_PATHS.map(p => `Disallow: ${p}`);
  return [
    'User-agent: *',
    ...privateRules,
    '',
    ...CITING_CRAWLERS.map(bot => `User-agent: ${bot}`),
    ...privateRules,
    '',
    ...TRAINING_CRAWLERS.map(bot => `User-agent: ${bot}`),
    'Disallow: /',
    '',
    `Sitemap: ${new URL('/sitemap.xml', origin).toString()}`,
    '',
  ].join('\n');
}

/**
 * /llms.txt (llmstxt.org): what Graphinity is and how to read and cite it,
 * for AI assistants. Plain Markdown, built from the site's own address.
 */
export function llmsTxt(origin: string): string {
  const at = (path: string) => new URL(path, origin).toString();
  return [
    '# Graphinity',
    '',
    '> Questions answered by people who have done the thing themselves. A question is routed to the people most likely to have first-hand experience of it, and the asker picks the answer that helped.',
    '',
    'How to read a question page:',
    '',
    '- Each answer is one person’s first-hand report, not a verified fact. Quote it as that person’s experience.',
    '- When three or more answers report an amount, the page summarises how far they agree, weighed by each person’s record in that field. Smaller groups are shown, not hidden: an unusual case is information.',
    '- The answer the asker picked as the one that helped is marked as accepted in the page’s Schema.org QAPage data.',
    '- Only questions with at least one answer are offered to search; unanswered ones are marked noindex.',
    '- Cite the question’s own address, which each page gives as its canonical link.',
    '',
    '## Pages',
    '',
    `- [Recent questions](${at('/')}): the newest questions and their answers`,
    `- [Sitemap](${at('/sitemap.xml')}): every answered question, with the date of its latest answer`,
    `- [Privacy](${at('/privacy')}): what Graphinity stores and why`,
    `- [Terms](${at('/terms')})`,
    '',
  ].join('\n');
}

/** The fixed pages, plus any extra (questions, from the host's sitemap function). */
export function sitemapXml(origin: string, extra: Array<{ path: string; lastmod: string }> = []): string {
  const entries = [...PUBLIC_PATHS.map(path => ({ path, lastmod: '' })), ...extra];
  const urls = entries
    .map(
      e =>
        `  <url><loc>${escapeXml(new URL(e.path, origin).toString())}</loc>${e.lastmod ? `<lastmod>${escapeXml(e.lastmod)}</lastmod>` : ''}</url>`,
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c] ?? c);
}
