import { generateKeyPair, SignJWT, UnsecuredJWT } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { AuthError, AuthUnavailableError, createTokenVerifier, subjectHash, type TokenVerifier } from '../src/auth.ts';
import { TEST_ISSUER, testIssuer } from './helpers/tokens.ts';

let issuer: Awaited<ReturnType<typeof testIssuer>>;
let verifier: TokenVerifier;

beforeAll(async () => {
  issuer = await testIssuer();
  verifier = createTokenVerifier({ issuer: TEST_ISSUER, keys: issuer.keys });
});

async function rejected(token: string) {
  await expect(verifier.verify(token)).rejects.toBeInstanceOf(AuthError);
}

describe('createTokenVerifier', () => {
  it('accepts a genuine token and returns the user id', async () => {
    const sub = '7b1c3f0e-1d2a-4c5b-9e8f-0a1b2c3d4e5f';
    expect(await verifier.verify(await issuer.sign({}, { sub }))).toEqual({ id: sub });
  });

  it('refuses an expired token', async () => {
    const issuedAt = Math.floor(Date.now() / 1000) - 7200;
    await rejected(await issuer.sign({}, { issuedAt, lifetime: 3600 }));
  });

  it('refuses a token from another Supabase project', async () => {
    await rejected(await issuer.sign({}, { issuer: 'https://other-project.supabase.co/auth/v1' }));
  });

  it('refuses a token signed by any other key', async () => {
    const { privateKey } = await generateKeyPair('ES256');
    await rejected(await issuer.sign({}, { key: privateKey }));
  });

  it('refuses a token whose contents were edited after signing', async () => {
    const token = await issuer.sign({}, { sub: '7b1c3f0e-1d2a-4c5b-9e8f-0a1b2c3d4e5f' });
    const [h, p, s] = token.split('.');
    const payload = JSON.parse(Buffer.from(p!, 'base64url').toString());
    payload.sub = '00000000-0000-4000-8000-000000000000';
    await rejected(`${h}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${s}`);
  });

  it('refuses an unsigned token (alg "none")', async () => {
    const token = new UnsecuredJWT({ role: 'authenticated' })
      .setIssuer(TEST_ISSUER).setAudience('authenticated').setSubject('7b1c3f0e-1d2a-4c5b-9e8f-0a1b2c3d4e5f')
      .setIssuedAt().setExpirationTime('1h').encode();
    await rejected(token);
  });

  it('refuses HS256 "signed" with the public key as the secret (algorithm confusion)', async () => {
    const secret = new TextEncoder().encode(JSON.stringify(issuer.jwk));
    const token = await new SignJWT({ role: 'authenticated' })
      .setProtectedHeader({ alg: 'HS256', kid: 'test-key-1' })
      .setIssuer(TEST_ISSUER).setAudience('authenticated').setSubject('7b1c3f0e-1d2a-4c5b-9e8f-0a1b2c3d4e5f')
      .setIssuedAt().setExpirationTime('1h').sign(secret);
    await rejected(token);
  });

  it('refuses the anon role, anonymous users and the service role', async () => {
    await rejected(await issuer.sign({ role: 'anon' }));
    await rejected(await issuer.sign({ is_anonymous: true }));
    await rejected(await issuer.sign({ role: 'service_role' }));
  });

  it('refuses a token that lives longer than an hour, so deleted accounts stay locked out', async () => {
    await rejected(await issuer.sign({}, { lifetime: 7 * 24 * 3600 }));
  });

  it('refuses a subject that is not a user id', async () => {
    await rejected(await issuer.sign({}, { sub: 'admin' }));
  });

  it('refuses garbage and oversized input without throwing anything else', async () => {
    await rejected('not-a-token');
    await rejected('');
    await rejected('a'.repeat(10_000));
  });

  it('reports key-loading failures as unavailable, not as a bad token', async () => {
    const broken = createTokenVerifier({ issuer: TEST_ISSUER, keys: async () => { throw new TypeError('fetch failed'); } });
    await expect(broken.verify(await issuer.sign())).rejects.toBeInstanceOf(AuthUnavailableError);
  });
});

describe('subjectHash', () => {
  it('is stable, keyed and does not contain the id', () => {
    const id = '7b1c3f0e-1d2a-4c5b-9e8f-0a1b2c3d4e5f';
    const k1 = Buffer.alloc(32, 1), k2 = Buffer.alloc(32, 2);
    expect(subjectHash(id, k1)).toBe(subjectHash(id, k1));
    expect(subjectHash(id, k1)).not.toBe(subjectHash(id, k2));
    expect(subjectHash(id, k1)).not.toContain('7b1c3f0e');
  });
});
