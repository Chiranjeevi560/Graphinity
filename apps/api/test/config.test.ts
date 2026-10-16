import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.ts';

const key = 'ab'.repeat(32);
const prod = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgres://u:p@db.example:5432/x',
  WEB_ORIGIN: 'https://graphinity.pages.dev',
  TRUST_PROXY_HOPS: '1',
  IP_HASH_KEY: key,
  SUPABASE_URL: 'https://abcd.supabase.co',
  SUPABASE_SECRET_KEY: 'sb_secret_0123456789abcdefghij',
};

describe('loadConfig', () => {
  it('accepts a complete production environment', () => {
    const c = loadConfig(prod);
    expect(c).toMatchObject({ production: true, host: '0.0.0.0', trustProxyHops: 1, webOrigin: prod.WEB_ORIGIN });
    expect(c.ipHashKey.length).toBe(32);
  });

  it('has safe development defaults: no proxies trusted, local origin', () => {
    const c = loadConfig({ DATABASE_URL: prod.DATABASE_URL, IP_HASH_KEY: key, SUPABASE_SECRET_KEY: prod.SUPABASE_SECRET_KEY });
    expect(c).toMatchObject({ production: false, host: '127.0.0.1', trustProxyHops: 0, webOrigin: 'http://localhost:5173', supabaseUrl: 'http://localhost:54321' });
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

  it('refuses an http Supabase URL in production and a missing secret key', () => {
    expect(() => loadConfig({ ...prod, SUPABASE_URL: 'http://abcd.supabase.co' })).toThrow(/SUPABASE_URL must use https/);
    expect(() => loadConfig({ ...prod, SUPABASE_SECRET_KEY: undefined })).toThrow(/SUPABASE_SECRET_KEY/);
  });

  it('lists every problem at once and never echoes the values', () => {
    try {
      loadConfig({ NODE_ENV: 'production', DATABASE_URL: 'mysql://secret-password@x', IP_HASH_KEY: 'deadbeef', SUPABASE_SECRET_KEY: 'short-secret' });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const msg = (err as Error).message;
      for (const name of ['DATABASE_URL', 'WEB_ORIGIN', 'TRUST_PROXY_HOPS', 'IP_HASH_KEY', 'SUPABASE_URL', 'SUPABASE_SECRET_KEY']) expect(msg).toContain(name);
      expect(msg).not.toContain('secret-password');
      expect(msg).not.toContain('short-secret');
      expect(msg).not.toContain('deadbeef');
    }
  });
});
