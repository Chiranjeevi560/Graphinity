// Security headers for the website. One source for three places: the
// Cloudflare Pages `_headers` file, the local `vite preview` server (so the
// real policy is exercised in a browser before deploying), and the tests.

export interface HeaderOptions {
  /** Origins the page may call: the API, later Supabase Auth. */
  connectSrc: string[];
}

export function contentSecurityPolicy({ connectSrc }: HeaderOptions): string {
  return [
    "default-src 'none'",
    // No inline scripts at all; the build fails if one appears (see vite.config.ts).
    "script-src 'self'",
    // Inline style attributes are blocked; styles set from script via the
    // style object (squircle clip paths) are not affected by CSP.
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src ${["'self'", ...connectSrc].join(' ')}`,
    "manifest-src 'self'",
    "worker-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    'upgrade-insecure-requests',
  ].join('; ');
}

export function securityHeaders(options: HeaderOptions): Record<string, string> {
  return {
    'Content-Security-Policy': contentSecurityPolicy(options),
    'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    // Links people paste must not tell other sites which question they came from.
    'Referrer-Policy': 'same-origin',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  };
}

/** The Cloudflare Pages `_headers` file. */
export function pagesHeadersFile(options: HeaderOptions): string {
  const all = Object.entries(securityHeaders(options)).map(([k, v]) => `  ${k}: ${v}`).join('\n');
  return [
    '/*',
    all,
    '',
    // Hashed file names change on every deploy, so they can be cached forever.
    '/assets/*',
    '  Cache-Control: public, max-age=31536000, immutable',
    '',
    // The page itself must always be re-checked, or people keep an old version.
    '/',
    '  Cache-Control: no-cache',
    '/index.html',
    '  Cache-Control: no-cache',
    '',
  ].join('\n');
}

/** Throws if the built HTML contains a script without a src. */
export function assertNoInlineScripts(html: string): void {
  const inline = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].filter(
    ([, attrs, body]) => !/\bsrc\s*=/.test(attrs ?? '') && (body ?? '').trim() !== '',
  );
  if (inline.length) {
    throw new Error(`index.html has ${inline.length} inline script(s); the Content-Security-Policy would block them.`);
  }
}
