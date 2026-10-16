// Checks sign-in tokens issued by Supabase Auth. The server verifies every
// token itself, against Supabase's published public keys: it never trusts the
// website's word for who someone is.
import { createHmac } from 'node:crypto';
import { createRemoteJWKSet, errors, jwtVerify, type JWTVerifyGetKey } from 'jose';

export interface SignedInUser {
  id: string;
}

export interface TokenVerifier {
  verify(token: string): Promise<SignedInUser>;
}

/** The token is missing, forged, expired or not for us: the person must sign in again. */
export class AuthError extends Error {
  override name = 'AuthError';
}

/** We couldn't check the token (Supabase's keys didn't load). Not the person's fault. */
export class AuthUnavailableError extends Error {
  override name = 'AuthUnavailableError';
}

/**
 * Longest token lifetime accepted. Supabase's default is one hour. Deleted
 * accounts are remembered for longer than this (see profile routes), so a
 * longer-lived token could outlast that memory; such tokens are refused.
 */
export const MAX_TOKEN_LIFETIME_SECONDS = 3600;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface VerifierOptions {
  /** e.g. https://abcd.supabase.co/auth/v1 */
  issuer: string;
  /** Resolves a token's key id to a public key. Remote in production, local in tests. */
  keys: JWTVerifyGetKey;
}

export function createTokenVerifier({ issuer, keys }: VerifierOptions): TokenVerifier {
  return {
    async verify(token) {
      // A real token is well under 2 KB; refuse giant inputs before parsing.
      if (token.length > 4096) throw new AuthError('token too long');
      let payload;
      try {
        ({ payload } = await jwtVerify(token, keys, {
          issuer,
          audience: 'authenticated',
          // Only asymmetric algorithms: a token "signed" with HS256 using the
          // public key as the secret, or with alg "none", is refused here.
          algorithms: ['ES256', 'RS256'],
          clockTolerance: 30,
          requiredClaims: ['sub', 'exp', 'iat'],
        }));
      } catch (err) {
        if (err instanceof errors.JWKSTimeout) throw new AuthUnavailableError(err.code);
        if (err instanceof errors.JOSEError) throw new AuthError(err.code);
        // Anything else is a failure to fetch keys (network, DNS), not a bad token.
        throw new AuthUnavailableError((err as Error).name);
      }
      if (typeof payload.exp !== 'number' || typeof payload.iat !== 'number' || payload.exp - payload.iat > MAX_TOKEN_LIFETIME_SECONDS + 60) {
        throw new AuthError('lifetime');
      }
      if (payload.role !== 'authenticated') throw new AuthError('role');
      if (payload.is_anonymous === true) throw new AuthError('anonymous');
      if (typeof payload.sub !== 'string' || !UUID.test(payload.sub)) throw new AuthError('sub');
      return { id: payload.sub.toLowerCase() };
    },
  };
}

/** Supabase's public signing keys, cached; refetched when a new key id appears. */
export function supabaseKeys(supabaseUrl: string): JWTVerifyGetKey {
  return createRemoteJWKSet(new URL('/auth/v1/.well-known/jwks.json', supabaseUrl), {
    timeoutDuration: 5_000,
    cooldownDuration: 30_000,
    cacheMaxAge: 10 * 60_000,
  });
}

/**
 * A non-reversible stand-in for a user id, for remembering deleted accounts
 * without keeping their id. Domain-separated from visitor hashes.
 */
export function subjectHash(userId: string, key: Buffer): string {
  return createHmac('sha256', key).update(`subject:${userId}`).digest('base64url');
}
