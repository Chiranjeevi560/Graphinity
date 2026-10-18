import { createServer, type Server } from 'node:http';
import { generateKeyPair, SignJWT, UnsecuredJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthError, AuthUnavailableError, createTokenVerifier, subjectHash, supabaseKeys, type TokenVerifier } from '../src/auth.ts';
import { TEST_ISSUER, testIssuer } from './helpers/tokens.ts';
import { must } from './helpers/must.ts';

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
    const payload = JSON.parse(Buffer.from(must(p, 'the payload part'), 'base64url').toString()) as Record<string, unknown>;
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

  it('refuses a token dated in the future, which could outlive the deleted-account lockout', async () => {
    const issuedAt = Math.floor(Date.now() / 1000) + 3 * 3600;
    await rejected(await issuer.sign({}, { issuedAt, lifetime: 3600 }));
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
    const broken = createTokenVerifier({ issuer: TEST_ISSUER, keys: () => Promise.reject(new TypeError('fetch failed')) });
    await expect(broken.verify(await issuer.sign())).rejects.toBeInstanceOf(AuthUnavailableError);
  });
});

describe('when Supabase\'s key service misbehaves', () => {
  // A local stand-in for the key endpoint whose answer each test chooses.
  let respond: (res: import('node:http').ServerResponse) => void = res => res.end();
  let server: Server;
  let base: string;
  beforeAll(async () => {
    server = createServer((_req, res) => { respond(res); }).listen(0, '127.0.0.1');
    await new Promise(r => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => { server.close(); });

  // Each case gets a fresh key cache, as a server would after its cache expired.
  async function verifyAgainst(answer: typeof respond) {
    respond = answer;
    const verifier = createTokenVerifier({ issuer: `${base}/auth/v1`, keys: supabaseKeys(base) });
    return verifier.verify(await issuer.sign({}, { issuer: `${base}/auth/v1` }));
  }

  it('reports an error status as "can\'t check right now", not as signed out', async () => {
    await expect(verifyAgainst(res => { res.writeHead(503, { 'content-type': 'text/html' }); res.end('<h1>Service Unavailable</h1>'); }))
      .rejects.toBeInstanceOf(AuthUnavailableError);
  });

  it('reports a body that is not JSON the same way', async () => {
    await expect(verifyAgainst(res => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html>maintenance</html>'); }))
      .rejects.toBeInstanceOf(AuthUnavailableError);
  });

  it('reports JSON that is not a key set the same way', async () => {
    await expect(verifyAgainst(res => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"hello":"world"}'); }))
      .rejects.toBeInstanceOf(AuthUnavailableError);
  });

  it('still treats a token signed by a key the service does not list as a bad token', async () => {
    await expect(verifyAgainst(res => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ keys: [] })); }))
      .rejects.toBeInstanceOf(AuthError);
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
