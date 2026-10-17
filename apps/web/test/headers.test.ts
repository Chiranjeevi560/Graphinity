import { describe, expect, it } from 'vitest';
import { assertNoInlineScripts, contentSecurityPolicy, pagesHeadersFile } from '../headers.ts';

const options = { connectSrc: ['https://api.example.onrender.com'] };

describe('content security policy', () => {
  const csp = contentSecurityPolicy(options);

  it('denies by default and allows scripts and styles only from our own origin', () => {
    expect(csp).toMatch(/^default-src 'none'/);
    expect(csp).toContain("script-src 'self';");
    expect(csp).toContain("style-src 'self';");
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
  });

  it('can only connect to our own origin and the configured API', () => {
    expect(csp).toContain("connect-src 'self' https://api.example.onrender.com;");
  });

  it('upgrades insecure requests on deploys, and only skips that for local http previews', () => {
    expect(csp).toContain('upgrade-insecure-requests');
    expect(pagesHeadersFile(options)).toContain('upgrade-insecure-requests');
    expect(contentSecurityPolicy({ ...options, localHttp: true })).not.toContain('upgrade-insecure-requests');
  });

  it('cannot be framed and has no base-uri', () => {
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'none'");
  });
});

describe('_headers file', () => {
  const file = pagesHeadersFile(options);

  it('applies the security headers to every path', () => {
    const block = file.split('\n\n')[0]!;
    expect(block.split('\n')[0]).toBe('/*');
    for (const h of ['Content-Security-Policy', 'Strict-Transport-Security', 'X-Content-Type-Options: nosniff', 'Referrer-Policy: same-origin']) {
      expect(block).toContain(h);
    }
  });

  it('caches hashed assets forever but always re-checks the page itself', () => {
    expect(file).toMatch(/\/assets\/\*\n {2}Cache-Control: public, max-age=31536000, immutable/);
    expect(file).toMatch(/\/index\.html\n {2}Cache-Control: no-cache/);
  });
});

describe('assertNoInlineScripts', () => {
  it('accepts external module scripts', () => {
    expect(() => assertNoInlineScripts('<script type="module" crossorigin src="/assets/index-abc.js"></script>')).not.toThrow();
  });

  it('rejects an inline script, which the policy would silently block in production', () => {
    expect(() => assertNoInlineScripts('<script>window.x = 1</script>')).toThrow(/inline script/);
  });
});
