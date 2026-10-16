import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.ts';

const key = 'ab'.repeat(32);
const prod = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgres://u:p@db.example:5432/x',
  WEB_ORIGIN: 'https://graphinity.pages.dev',
  TRUST_PROXY_HOPS: '1',
  IP_HASH_KEY: key,
};

describe('loadConfig', () => {
  it('accepts a complete production environment', () => {
    const c = loadConfig(prod);
    expect(c).toMatchObject({ production: true, host: '0.0.0.0', trustProxyHops: 1, webOrigin: prod.WEB_ORIGIN });
    expect(c.ipHashKey.length).toBe(32);
  });

  it('has safe development defaults: no proxies trusted, local origin', () => {
    const c = loadConfig({ DATABASE_URL: prod.DATABASE_URL, IP_HASH_KEY: key });
    expect(c).toMatchObject({ production: false, host: '127.0.0.1', trustProxyHops: 0, webOrigin: 'http://localhost:5173' });
  });

  it('refuses production without a measured proxy count', () => {
    const { TRUST_PROXY_HOPS: _, ...env } = prod;
    expect(() => loadConfig(env)).toThrow(/TRUST_PROXY_HOPS/);
  });

  it('refuses a short or missing hashing key', () => {
    expect(() => loadConfig({ ...prod, IP_HASH_KEY: 'abcd' })).toThrow(/IP_HASH_KEY/);
    expect(() => loadConfig({ ...prod, IP_HASH_KEY: undefined })).toThrow(/IP_HASH_KEY/);
  });

  it('refuses an http origin in production and an origin with a path anywhere', () => {
    expect(() => loadConfig({ ...prod, WEB_ORIGIN: 'http://graphinity.pages.dev' })).toThrow(/https/);
    expect(() => loadConfig({ ...prod, WEB_ORIGIN: 'https://graphinity.pages.dev/app' })).toThrow(/WEB_ORIGIN/);
  });

  it('lists every problem at once and never echoes the values', () => {
    try {
      loadConfig({ NODE_ENV: 'production', DATABASE_URL: 'mysql://secret-password@x', IP_HASH_KEY: 'deadbeef' });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const msg = (err as Error).message;
      for (const name of ['DATABASE_URL', 'WEB_ORIGIN', 'TRUST_PROXY_HOPS', 'IP_HASH_KEY']) expect(msg).toContain(name);
      expect(msg).not.toContain('secret-password');
      expect(msg).not.toContain('deadbeef');
    }
  });
});
