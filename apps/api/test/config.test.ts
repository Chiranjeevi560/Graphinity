import { createECDH } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.ts';
import { privateKeyText } from '../src/push.ts';

const key = 'ab'.repeat(32);
const prod = {
  NODE_ENV: 'production',
  APP_ENV: 'production',
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

  it('takes Cloudflare Workers AI settings both or neither, and checks their shape without echoing them', () => {
    const account = 'a'.repeat(32), token = 'cf_token_0123456789abcdef';
    expect(loadConfig(prod).workersAi).toBeNull();
    expect(loadConfig({ ...prod, CF_ACCOUNT_ID: account, CF_AI_TOKEN: token }).workersAi).toEqual({ accountId: account, token });
    expect(() => loadConfig({ ...prod, CF_ACCOUNT_ID: account })).toThrow(/CF_AI_TOKEN/);
    expect(() => loadConfig({ ...prod, CF_AI_TOKEN: token })).toThrow(/CF_ACCOUNT_ID/);
    try { loadConfig({ ...prod, CF_ACCOUNT_ID: 'not-an-id', CF_AI_TOKEN: token }); } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as Error).message).not.toContain(token);
    }
  });

  it('has safe development defaults: no proxies trusted, local origin', () => {
    const c = loadConfig({ DATABASE_URL: prod.DATABASE_URL, IP_HASH_KEY: key, SUPABASE_SECRET_KEY: prod.SUPABASE_SECRET_KEY });
    expect(c).toMatchObject({ production: false, host: '127.0.0.1', trustProxyHops: 0, webOrigin: 'http://localhost:5173', supabaseUrl: 'http://localhost:54321' });
  });

  it('knows which environment it is: a deployed server must say staging or production', () => {
    expect(loadConfig(prod).environment).toBe('production');
    expect(loadConfig({ ...prod, APP_ENV: 'staging' }).environment).toBe('staging');
    const { APP_ENV: _, ...unnamed } = prod;
    expect(() => loadConfig(unnamed)).toThrow(/APP_ENV/);
    expect(() => loadConfig({ ...prod, APP_ENV: 'development' })).toThrow(/APP_ENV/);
    expect(() => loadConfig({ ...prod, APP_ENV: 'Production' })).toThrow(/APP_ENV/);
    // On your computer it is development, and can't claim to be anything else.
    const dev = { DATABASE_URL: prod.DATABASE_URL, IP_HASH_KEY: key, SUPABASE_SECRET_KEY: prod.SUPABASE_SECRET_KEY };
    expect(loadConfig(dev).environment).toBe('development');
    expect(() => loadConfig({ ...dev, APP_ENV: 'production' })).toThrow(/APP_ENV/);
  });

  it('carries the commit it was built from, when the build says, and checks its shape', () => {
    const sha = 'a1b2c3d4'.repeat(5);
    expect(loadConfig(prod).release).toBeNull();
    expect(loadConfig({ ...prod, RELEASE: sha }).release).toBe(sha);
    expect(() => loadConfig({ ...prod, RELEASE: 'main' })).toThrow(/RELEASE/);
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

describe('web push keys', () => {
  const pair = () => {
    const ecdh = createECDH('prime256v1');
    ecdh.generateKeys();
    return { VAPID_PUBLIC_KEY: ecdh.getPublicKey().toString('base64url'), VAPID_PRIVATE_KEY: privateKeyText(ecdh) };
  };

  it('are optional: without them, push is off', () => {
    expect(loadConfig(prod).vapid).toBeNull();
  });

  it('are accepted as a matching pair, signing as the website by default', () => {
    const keys = pair();
    expect(loadConfig({ ...prod, ...keys }).vapid).toEqual({ publicKey: keys.VAPID_PUBLIC_KEY, privateKey: keys.VAPID_PRIVATE_KEY, subject: prod.WEB_ORIGIN });
  });

  it('refuse half a pair or two halves of different pairs, without echoing the secret', () => {
    const a = pair(), b = pair();
    expect(() => loadConfig({ ...prod, VAPID_PUBLIC_KEY: a.VAPID_PUBLIC_KEY })).toThrow(/VAPID/);
    expect(() => loadConfig({ ...prod, VAPID_PRIVATE_KEY: a.VAPID_PRIVATE_KEY })).toThrow(/VAPID/);
    try {
      loadConfig({ ...prod, VAPID_PUBLIC_KEY: a.VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY: b.VAPID_PRIVATE_KEY });
      expect.unreachable();
    } catch (err) {
      expect(String(err)).toMatch(/matching P-256 pair/);
      expect(String(err)).not.toContain(b.VAPID_PRIVATE_KEY);
    }
  });

  it('accept a key whose first byte is zero (Node drops it; we pad it back)', () => {
    const ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(Buffer.concat([Buffer.alloc(1), Buffer.alloc(31, 7)]));
    expect(ecdh.getPrivateKey()).toHaveLength(31);
    const keys = { VAPID_PUBLIC_KEY: ecdh.getPublicKey().toString('base64url'), VAPID_PRIVATE_KEY: privateKeyText(ecdh) };
    expect(keys.VAPID_PRIVATE_KEY).toHaveLength(43);
    expect(loadConfig({ ...prod, ...keys }).vapid?.privateKey).toBe(keys.VAPID_PRIVATE_KEY);
  });
});

