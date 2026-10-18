// Local stand-in for Supabase Auth, for development only.
//
// It implements just the parts Graphinity uses, with the same paths and
// request shapes as Google and Supabase (Supabase's checked against its
// source, internal/api/token_oidc.go):
//   GET  /o/oauth2/v2/auth?client_id&redirect_uri&response_type=id_token&scope&nonce&state   (plays Google)
//   POST /auth/v1/token?grant_type=id_token        { provider: 'google', id_token, nonce }
//   POST /auth/v1/token?grant_type=refresh_token   { refresh_token }
//   POST /auth/v1/logout                            (Bearer access token)
//   GET  /auth/v1/.well-known/jwks.json
//   DELETE /auth/v1/admin/users/:id                 (apikey: the dev secret key)
// Instead of Google's account chooser, it shows a page for picking a test person.
//
// It signs real ES256 tokens with a key made at startup, so the API's
// verifier runs exactly as in production. It listens on 127.0.0.1 only, and
// the API refuses a non-https Supabase URL in production, so it can never be
// trusted outside development.
//
//   npm run dev:auth
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { exportJWK, generateKeyPair, jwtVerify, SignJWT } from 'jose';

const PORT = 54321;
const ORIGIN = `http://localhost:${PORT}`;
const ISSUER = `${ORIGIN}/auth/v1`;
// Like the redirect URIs registered at Google: only our local website's
// callback may receive tokens.
const ALLOWED_REDIRECT_ORIGINS = ['http://localhost:5173', 'http://localhost:4173'];
// The website's default client ID while developing (apps/web/vite.config.ts).
const GOOGLE_CLIENT_ID = 'dev-client.apps.googleusercontent.com';
const GOOGLE_ISSUER = `${ORIGIN}/google`;

const env = Object.fromEntries(
  readFileSync(new URL('../.local/api.env', import.meta.url), 'utf8')
    .split('\n').filter(Boolean).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);
// Tests pass their own throwaway secret, so the real one in .local/api.env
// never leaves for anywhere but Supabase.
const SECRET_KEY = process.env.DEV_AUTH_SECRET_KEY ?? env.SUPABASE_SECRET_KEY;
if (!SECRET_KEY) throw new Error('Run `npm run db:start` first: it writes the dev secret key to .local/api.env');

const { publicKey, privateKey } = await generateKeyPair('ES256');
const KID = `dev-${randomBytes(4).toString('hex')}`;
const jwks = { keys: [{ ...(await exportJWK(publicKey)), kid: KID, alg: 'ES256', use: 'sig' }] };

// Fixed people so a developer can come back as the same person.
const people = [
  { id: '11111111-1111-4111-8111-111111111111', label: 'Test person A' },
  { id: '22222222-2222-4222-8222-222222222222', label: 'Test person B' },
  { id: '33333333-3333-4333-8333-333333333333', label: 'Test person C' },
];
const deleted = new Set();
const refreshTokens = new Map(); // token -> sub

const b64url = buf => Buffer.from(buf).toString('base64url');
const sha256Hex = s => createHash('sha256').update(s).digest('hex');

function allowedCallback(raw) {
  try {
    const u = new URL(raw);
    return ALLOWED_REDIRECT_ORIGINS.includes(u.origin) && u.pathname === '/auth/callback' && !u.search && !u.hash;
  } catch { return false; }
}

async function session(sub) {
  const now = Math.floor(Date.now() / 1000);
  const accessToken = await new SignJWT({
    role: 'authenticated', aal: 'aal1', is_anonymous: false, session_id: randomUUID(),
    // A real Supabase token carries the email. Graphinity must never use it;
    // including it here lets the tests prove that.
    email: `${sub.slice(0, 8)}@example.test`,
  })
    .setProtectedHeader({ alg: 'ES256', kid: KID, typ: 'JWT' })
    .setIssuer(ISSUER).setAudience('authenticated').setSubject(sub)
    .setIssuedAt(now).setExpirationTime(now + 3600)
    .sign(privateKey);
  const refresh = b64url(randomBytes(24));
  refreshTokens.set(refresh, sub);
  return { access_token: accessToken, token_type: 'bearer', expires_in: 3600, expires_at: now + 3600, refresh_token: refresh, user: { id: sub } };
}

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string';
  res.writeHead(status, { 'content-type': isJson ? 'application/json' : 'text/html; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(isJson ? JSON.stringify(body) : body);
}

function cors(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_REDIRECT_ORIGINS.includes(origin)) {
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('access-control-allow-headers', 'apikey, authorization, content-type');
    res.setHeader('access-control-allow-methods', 'GET, POST, DELETE');
    res.setHeader('vary', 'origin');
  }
}

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 8192) throw new Error('too large');
  }
  if ((req.headers['content-type'] ?? '').includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(raw));
  return raw ? JSON.parse(raw) : {};
}

const escapeHtml = s => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function pickerPage(params) {
  const hidden = ['redirect_uri', 'nonce', 'state'].map(k => `<input type="hidden" name="${k}" value="${escapeHtml(params.get(k) ?? '')}">`).join('');
  const buttons = [...people, { id: 'new', label: 'A brand-new person' }]
    .map(p => `<button name="sub" value="${p.id}">${p.label}${deleted.has(p.id) ? ' (deleted, will start fresh)' : ''}</button>`).join('');
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Local test sign-in</title>
<style>body{font:17px system-ui;max-width:28rem;margin:3rem auto;padding:0 1rem}button{display:block;width:100%;min-height:44px;margin:.5rem 0;font:inherit;border-radius:12px;border:1px solid #ccc;background:#f2f2f7}p{color:#666}</style>
<h1>Local test sign-in</h1>
<p>This page stands in for Google while developing. Nothing here leaves your computer.</p>
<form method="post" action="/o/oauth2/dev-login">${hidden}${buttons}</form>`;
}

const server = createServer(async (req, res) => {
  cors(req, res);
  if (req.method === 'OPTIONS') return send(res, 204, '');
  const url = new URL(req.url, ORIGIN);
  try {
    if (req.method === 'GET' && url.pathname === '/auth/v1/.well-known/jwks.json') return send(res, 200, jwks);

    if (req.method === 'GET' && url.pathname === '/o/oauth2/v2/auth') {
      const q = url.searchParams;
      // Google refuses these with an error page of its own; so does this.
      if (q.get('client_id') !== GOOGLE_CLIENT_ID) return send(res, 400, { error: 'invalid_client' });
      if (!allowedCallback(q.get('redirect_uri') ?? '')) return send(res, 400, { error: 'redirect_uri_mismatch' });
      if (q.get('response_type') !== 'id_token') return send(res, 400, { error: 'unsupported_response_type' });
      if (!(q.get('scope') ?? '').split(' ').includes('openid')) return send(res, 400, { error: 'invalid_scope' });
      if (!q.get('nonce') || !q.get('state')) return send(res, 400, { error: 'nonce and state are required' });
      return send(res, 200, pickerPage(q));
    }

    if (req.method === 'POST' && url.pathname === '/o/oauth2/dev-login') {
      const body = await readBody(req);
      if (!allowedCallback(body.redirect_uri)) return send(res, 400, { error: 'redirect_uri_mismatch' });
      const sub = body.sub === 'new' ? randomUUID() : body.sub;
      if (deleted.has(sub)) deleted.delete(sub);
      const now = Math.floor(Date.now() / 1000);
      const idToken = await new SignJWT({ nonce: body.nonce, email: `${sub.slice(0, 8)}@example.test`, email_verified: true })
        .setProtectedHeader({ alg: 'ES256', kid: KID, typ: 'JWT' })
        .setIssuer(GOOGLE_ISSUER).setAudience(GOOGLE_CLIENT_ID).setSubject(sub)
        .setIssuedAt(now).setExpirationTime(now + 3600)
        .sign(privateKey);
      const fragment = new URLSearchParams({ id_token: idToken, state: body.state });
      return send(res, 302, '', { location: `${body.redirect_uri}#${fragment}` });
    }

    if (req.method === 'POST' && url.pathname === '/auth/v1/token') {
      const body = await readBody(req);
      const grant = url.searchParams.get('grant_type');
      if (grant === 'id_token') {
        if (body.provider !== 'google') return send(res, 400, { error: 'invalid_request', error_description: 'unsupported provider' });
        let claims;
        try {
          ({ payload: claims } = await jwtVerify(body.id_token ?? '', publicKey, { issuer: GOOGLE_ISSUER, audience: GOOGLE_CLIENT_ID }));
        } catch {
          return send(res, 400, { error: 'invalid_request', error_description: 'Bad ID token' });
        }
        // As Supabase does: the token carries the nonce's hash, the request the nonce.
        if (typeof body.nonce !== 'string' || typeof claims.nonce !== 'string' || sha256Hex(body.nonce) !== claims.nonce) {
          return send(res, 400, { error: 'invalid_nonce', error_description: 'Nonces mismatch' });
        }
        return send(res, 200, await session(claims.sub));
      }
      if (grant === 'refresh_token') {
        const sub = refreshTokens.get(body.refresh_token);
        refreshTokens.delete(body.refresh_token); // rotated, like Supabase
        if (!sub || deleted.has(sub)) return send(res, 400, { error: 'invalid_grant', error_description: 'refresh token not found' });
        return send(res, 200, await session(sub));
      }
      return send(res, 400, { error: 'unsupported_grant_type' });
    }

    if (req.method === 'POST' && url.pathname === '/auth/v1/logout') {
      // Real Supabase checks the token; here, dropping all refresh tokens of
      // whoever is named in it is enough for development.
      const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
      const payload = token.split('.')[1];
      const sub = payload ? JSON.parse(Buffer.from(payload, 'base64url')).sub : null;
      for (const [t, s] of refreshTokens) if (s === sub) refreshTokens.delete(t);
      return send(res, 204, '');
    }

    const adminMatch = url.pathname.match(/^\/auth\/v1\/admin\/users\/([0-9a-f-]{36})$/);
    if (req.method === 'DELETE' && adminMatch) {
      if (req.headers.apikey !== SECRET_KEY) return send(res, 401, { error: 'invalid api key' });
      const sub = adminMatch[1];
      // Same shape as Supabase's apierrors.HTTPError for a missing user.
      if (deleted.has(sub)) return send(res, 404, { code: 404, error_code: 'user_not_found', msg: 'User not found' });
      deleted.add(sub);
      for (const [t, s] of refreshTokens) if (s === sub) refreshTokens.delete(t);
      return send(res, 200, { id: sub });
    }

    return send(res, 404, { error: 'not found' });
  } catch {
    return send(res, 400, { error: 'bad request' });
  }
});

server.listen(PORT, '127.0.0.1', () => console.log(`Local test sign-in running at ${ORIGIN} (development only)`));
