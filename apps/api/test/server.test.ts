import { describe, expect, it } from 'vitest';
import { AuthError } from '../src/auth.ts';
import type { Database } from '../src/db.ts';
import { buildServer, defaultLimits, type Limits } from '../src/server.ts';
import type { Body } from './helpers/must.ts';

const ORIGIN = 'https://graphinity.pages.dev';

function fakeDb(overrides: Partial<Database> = {}): Database {
  return {
    ping: () => Promise.resolve({ schemaVersion: 7 }),
    withUser: () => Promise.reject(new Error('not used')),
    asSystem: () => Promise.reject(new Error('not used')),
    query: () => Promise.reject(new Error('not used')),
    assertRestricted: () => Promise.resolve(),
    close: () => Promise.resolve(),
    ...overrides,
  };
}

function logCollector() {
  const lines: string[] = [];
  return { lines, stream: { write: (l: string) => { lines.push(l); } } };
}

async function server(opts: { db?: Database; limits?: Partial<Limits>; hops?: number; logs?: ReturnType<typeof logCollector> } = {}) {
  const t = 0;
  const app = await buildServer({
    config: { production: true, webOrigin: ORIGIN, trustProxyHops: opts.hops ?? 0, ipHashKey: Buffer.alloc(32, 1) },
    db: opts.db ?? fakeDb(),
    clock: { now: () => t },
    // No signed-in routes are exercised here; profile.integration.test.ts covers them.
    auth: { verify: () => Promise.reject(new AuthError('unused')) },
    authAdmin: { deleteUser: () => Promise.resolve() },
    limits: { ...defaultLimits, ...opts.limits },
    logStream: (opts.logs ?? logCollector()).stream,
  });
  return app;
}

describe('health', () => {
  it('reports ok with the schema version when the database answers', async () => {
    const app = await server();
    const res = await app.inject('/health');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', schemaVersion: 7 });
  });

  it('reports 503 without details when the database fails', async () => {
    const app = await server({ db: fakeDb({ ping: () => Promise.reject(new Error('password authentication failed for user x')) }) });
    const res = await app.inject('/health');
    expect(res.statusCode).toBe(503);
    expect(res.body).not.toContain('password');
  });
});

describe('/meta', () => {
  it('reads the field and country lists once, not on every visit', async () => {
    let reads = 0;
    const db = fakeDb({
      withUser: (_user, fn) => {
        reads++;
        return fn({ query: () => Promise.resolve({ rows: [{ x: 1 }] }) } as never);
      },
    });
    const app = await server({ db });
    for (let i = 0; i < 5; i++) expect((await app.inject('/meta')).statusCode).toBe(200);
    expect(reads).toBe(1);
  });
});

describe('security headers', () => {
  it('are on successful responses, errors and rate-limited responses alike', async () => {
    const app = await server({ limits: { visitor: { capacity: 2, refillPerSecond: 0.001, maxKeys: 10 } } });
    const ok = await app.inject('/health');
    const missing = await app.inject('/nope');
    const limited = await app.inject('/health');
    expect([ok.statusCode, missing.statusCode, limited.statusCode]).toEqual([200, 404, 429]);
    for (const res of [ok, missing, limited]) {
      expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
      expect(res.headers['strict-transport-security']).toMatch(/max-age=\d{8}/);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
      expect(res.headers['cache-control']).toBe('no-store');
    }
  });
});

describe('errors', () => {
  it('404 says what happened in plain words', async () => {
    const res = await (await server()).inject('/no/such/address');
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not_found', message: 'There is nothing at this address.' });
  });

  it('500 hides the error message from both the visitor and the log', async () => {
    const logs = logCollector();
    const app = await server({ logs });
    app.get('/boom', () => { throw new Error('duplicate key (email)=(someone@example.com)'); });
    const res = await app.inject('/boom');
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('someone@example.com');
    expect(logs.lines.join('')).not.toContain('someone@example.com');
    expect(logs.lines.join('')).toContain('unhandled error');
  });
});

describe('rate limits', () => {
  const tight = { visitor: { capacity: 2, refillPerSecond: 0.001, maxKeys: 100 } };

  it('refuses a visitor past their limit with a Retry-After', async () => {
    const app = await server({ limits: tight });
    const codes = [];
    for (let i = 0; i < 3; i++) codes.push((await app.inject('/health')).statusCode);
    expect(codes).toEqual([200, 200, 429]);
    const res = await app.inject('/health');
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    expect(res.json<Body>().message).toMatch(/Wait a minute/);
  });

  it('lets the website read a "too many requests" answer, so people see the real reason', async () => {
    const app = await server({ limits: tight });
    const ask = (origin: string) => app.inject({ url: '/health', headers: { origin } });
    await ask(ORIGIN); await ask(ORIGIN);
    const limited = await ask(ORIGIN);
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(limited.headers['access-control-expose-headers']).toMatch(/retry-after/i);
    expect(String(limited.headers.vary)).toMatch(/origin/i);
    // Other sites still get nothing they could read.
    expect((await ask('https://evil.example')).headers['access-control-allow-origin']).toBeUndefined();
  });

  it('ignores X-Forwarded-For when no proxy is trusted, so forging it cannot dodge the limit', async () => {
    const app = await server({ limits: tight, hops: 0 });
    const codes = [];
    for (let i = 0; i < 3; i++) {
      codes.push((await app.inject({ url: '/health', headers: { 'x-forwarded-for': `198.51.100.${i}` } })).statusCode);
    }
    expect(codes).toEqual([200, 200, 429]);
  });

  it('with one trusted proxy, uses only the address that proxy saw', async () => {
    const app = await server({ limits: tight, hops: 1 });
    // The client forges extra entries on the left; only the right-most (added by our proxy) counts.
    const forged = (fake: string) => ({ url: '/health', headers: { 'x-forwarded-for': `${fake}, 203.0.113.9` } });
    const codes = [];
    for (let i = 0; i < 3; i++) codes.push((await app.inject(forged(`198.51.100.${i}`))).statusCode);
    expect(codes).toEqual([200, 200, 429]);
    // A genuinely different visitor behind the same proxy is unaffected.
    expect((await app.inject({ url: '/health', headers: { 'x-forwarded-for': '203.0.113.10' } })).statusCode).toBe(200);
  });

  it('a visitor already over their own limit cannot use up everyone else\'s allowance', async () => {
    // Real production limits: global 400 burst, visitor 60 burst. Clock frozen, so nothing refills.
    const app = await server({ hops: 1, limits: defaultLimits });
    const from = (ip: string) => app.inject({ url: '/health', headers: { 'x-forwarded-for': ip } });
    let ok = 0;
    for (let i = 0; i < 1000; i++) if ((await from('198.51.100.66')).statusCode === 200) ok++;
    expect(ok).toBe(60);
    // Three other people, each making their first request.
    for (const ip of ['203.0.113.1', '203.0.113.2', '203.0.113.3']) expect((await from(ip)).statusCode).toBe(200);
  });

  it('counts every address in one IPv6 /64 block as the same visitor', async () => {
    const app = await server({ limits: tight, hops: 1 });
    const codes = [];
    for (let i = 1; i <= 3; i++) {
      codes.push((await app.inject({ url: '/health', headers: { 'x-forwarded-for': `2001:db8:abcd:12::${i}` } })).statusCode);
    }
    expect(codes).toEqual([200, 200, 429]);
    expect((await app.inject({ url: '/health', headers: { 'x-forwarded-for': '2001:db8:abcd:99::1' } })).statusCode).toBe(200);
  });

  it('a global limit protects the server even when every request comes from a new address', async () => {
    const app = await server({ hops: 1, limits: { global: { capacity: 3, refillPerSecond: 0.001, maxKeys: 1 } } });
    const codes = [];
    for (let i = 0; i < 4; i++) {
      codes.push((await app.inject({ url: '/health', headers: { 'x-forwarded-for': `198.51.100.${i}` } })).statusCode);
    }
    expect(codes).toEqual([200, 200, 200, 429]);
  });
});

describe('body size', () => {
  it('refuses bodies over the anonymous limit before the route runs', async () => {
    const app = await server();
    let ran = false;
    app.post('/echo', () => { ran = true; return {}; });
    const res = await app.inject({ method: 'POST', url: '/echo', payload: { text: 'x'.repeat(defaultLimits.anonymousBodyBytes) } });
    expect(res.statusCode).toBe(413);
    expect(res.json<Body>().error).toBe('too_large');
    expect(ran).toBe(false);
  });
});

describe('CORS', () => {
  it('allows only the website origin', async () => {
    const app = await server();
    const preflight = (origin: string) => app.inject({
      method: 'OPTIONS', url: '/health',
      headers: { origin, 'access-control-request-method': 'GET' },
    });
    const good = await preflight(ORIGIN);
    const bad = await preflight('https://evil.example');
    expect(good.headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(bad.headers['access-control-allow-origin']).toBeUndefined();
    expect(good.headers['access-control-allow-credentials']).toBeUndefined();
  });
});

describe('logging', () => {
  it('records route patterns and status, never addresses, headers, query strings or user agents', async () => {
    const logs = logCollector();
    const app = await server({ logs, hops: 1 });
    await app.inject({
      url: '/health?email=someone@example.com',
      headers: { 'x-forwarded-for': '203.0.113.77', 'user-agent': 'SecretBrowser/1.0', authorization: 'Bearer tok_abc' },
    });
    const text = logs.lines.join('');
    expect(text).toContain('"route":"/health"');
    expect(text).toContain('"status":200');
    for (const leak of ['203.0.113.77', 'SecretBrowser', 'someone@example.com', 'tok_abc', 'remoteAddress', '"hostname"']) {
      expect(text).not.toContain(leak);
    }
  });
});
