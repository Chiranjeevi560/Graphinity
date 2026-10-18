// A stand-in for Supabase Auth's signing: a real ES256 key pair generated per
// test run. The server's verifier runs unchanged; it just trusts this key.
import { randomUUID } from 'node:crypto';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';

export const TEST_ISSUER = 'https://test-project.supabase.co/auth/v1';

export async function testIssuer() {
  const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid: 'test-key-1', alg: 'ES256', use: 'sig' };
  const keys = createLocalJWKSet({ keys: [jwk] });

  /** A token shaped like Supabase's, with any claim overridable. */
  async function sign(
    claims: JWTPayload & Record<string, unknown> = {},
    options: { sub?: string; lifetime?: number; issuedAt?: number; issuer?: string; key?: CryptoKey; alg?: string } = {},
  ) {
    const now = options.issuedAt ?? Math.floor(Date.now() / 1000);
    return new SignJWT({ role: 'authenticated', aal: 'aal1', is_anonymous: false, session_id: randomUUID(), ...claims })
      .setProtectedHeader({ alg: options.alg ?? 'ES256', kid: 'test-key-1', typ: 'JWT' })
      .setIssuer(options.issuer ?? TEST_ISSUER)
      .setAudience('authenticated')
      .setSubject(options.sub ?? randomUUID())
      .setIssuedAt(now)
      .setExpirationTime(now + (options.lifetime ?? 3600))
      .sign(options.key ?? privateKey);
  }

  return { keys, sign, jwk, privateKey };
}

/** Records deletions instead of calling Supabase; can be told to fail. */
export function fakeAuthAdmin() {
  const deleted: string[] = [];
  let failNext = false;
  return {
    deleted,
    failNextDelete() { failNext = true; },
    deleteUser(id: string) {
      if (failNext) { failNext = false; return Promise.reject(new Error('supabase unavailable')); }
      deleted.push(id);
      return Promise.resolve();
    },
  };
}
