import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAuth, safePath, SignInError, type AuthDeps } from '../src/lib/auth.ts';
import { randomToken, sha256Hex } from '../src/lib/random.ts';
import { must } from './must.ts';

// localStorage must never be used for anything sign-in related. Any access fails the test.
const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
beforeAll(() => {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('localStorage was touched'); } });
});
afterAll(() => {
  if (original) Object.defineProperty(globalThis, 'localStorage', original);
  else delete (globalThis as { localStorage?: unknown }).localStorage;
});

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, v); },
    removeItem: (k: string) => { map.delete(k); },
  };
}

interface Call { url: string; init: RequestInit }

function harness(responses: Array<() => Response> = []) {
  const storage = memoryStorage();
  const calls: Call[] = [];
  let redirectedTo = '';
  let clock = 1_800_000_000;
  const deps: AuthDeps = {
    supabaseUrl: 'https://proj.supabase.co',
    supabaseKey: 'sb_publishable_test',
    googleClientId: 'client-1.apps.googleusercontent.com',
    googleAuthorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    siteOrigin: 'https://graphinity.pages.dev',
    storage,
    fetch: ((url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve(must(responses.shift(), `a response for ${url}`)());
    }) as unknown as typeof fetch,
    redirect: url => { redirectedTo = url; },
    now: () => clock,
  };
  const auth = createAuth(deps);
  return { auth, storage, calls, responses, get redirectedTo() { return redirectedTo; }, tick(s: number) { clock += s; }, get now() { return clock; } };
}

const json = (body: object, status = 200) => () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const session = (n: number, expiresIn = 3600) => ({ access_token: `access-${n}`, refresh_token: `refresh-${n}`, expires_in: expiresIn });

/** The sign-in waiting in session storage between leaving and coming back. */
function pendingSignIn(h: ReturnType<typeof harness>): { nonce: string; state: string } {
  return JSON.parse(must(h.storage.map.get('graphinity:signin'), 'a pending sign-in')) as { nonce: string; state: string };
}

function bodyOf(call: { init: RequestInit }): unknown {
  if (typeof call.init.body !== 'string') throw new Error('test expected a JSON string body');
  return JSON.parse(call.init.body);
}

/** Starts sign-in and returns what Google would put in the callback's fragment. */
async function startAndReturn(h: ReturnType<typeof harness>, returnTo = '/') {
  await h.auth.startSignIn(returnTo);
  const authorize = new URL(h.redirectedTo);
  const params = new URLSearchParams({ id_token: 'google-id-token', state: must(authorize.searchParams.get('state'), 'state') });
  return { authorize, params };
}

describe('nonce and random values', () => {
  it('hashes the nonce as lowercase SHA-256 hex, the form Supabase compares', async () => {
    // FIPS 180-2 test vector for "abc".
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('makes long, URL-safe, different values every time', () => {
    const a = randomToken(), b = randomToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
  });
});

describe('starting sign-in', () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => { h = harness(); });

  it('goes to Google, which returns to this site, asking only for openid and email', async () => {
    const { authorize } = await startAndReturn(h);
    const q = authorize.searchParams;
    expect(authorize.origin + authorize.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(q.get('client_id')).toBe('client-1.apps.googleusercontent.com');
    // Our own address, so Google's screen names this site, not Supabase.
    expect(q.get('redirect_uri')).toBe('https://graphinity.pages.dev/auth/callback');
    expect(q.get('response_type')).toBe('id_token');
    // No "profile": Google doesn't share the person's name or photo.
    expect(q.get('scope')).toBe('openid email');
    expect(q.get('prompt')).toBe('select_account');
    const pending = pendingSignIn(h);
    expect(q.get('state')).toBe(pending.state);
    expect(q.get('nonce')).toBe(await sha256Hex(pending.nonce));
    // The nonce itself never leaves the browser; only its hash does.
    expect(h.redirectedTo).not.toContain(pending.nonce);
  });

  it('will only ever return to a path on this site', () => {
    expect(safePath('/me')).toBe('/me');
    expect(safePath('//evil.example')).toBe('/');
    expect(safePath('/\\evil.example')).toBe('/');
    expect(safePath('https://evil.example')).toBe('/');
    expect(safePath('javascript:alert(1)')).toBe('/');
  });
});

describe('finishing sign-in', () => {
  it('exchanges Google’s token with the raw nonce, keeps the access token in memory only', async () => {
    const h = harness([json(session(1))]);
    const { params } = await startAndReturn(h, '/me');
    const pending = pendingSignIn(h);
    expect(await h.auth.completeSignIn(params)).toEqual({ returnTo: '/me' });
    const call = must(h.calls[0], 'the token call');
    expect(call.url).toBe('https://proj.supabase.co/auth/v1/token?grant_type=id_token');
    expect(bodyOf(call)).toEqual({ provider: 'google', id_token: 'google-id-token', nonce: pending.nonce });
    expect((call.init.headers as Record<string, string>).apikey).toBe('sb_publishable_test');
    expect(await h.auth.getAccessToken()).toBe('access-1');
    // Session storage holds only the refresh token; the pending sign-in is gone.
    expect([...h.storage.map.keys()]).toEqual(['graphinity:refresh']);
    expect([...h.storage.map.values()].join()).not.toContain('access-1');
  });

  it('refuses a return whose state does not match, and does not call Supabase', async () => {
    const h = harness();
    const { params } = await startAndReturn(h);
    params.set('state', 'attacker-state');
    await expect(h.auth.completeSignIn(params)).rejects.toMatchObject({ reason: 'mismatch' });
    expect(h.calls).toHaveLength(0);
  });

  it('refuses a return with no sign-in started in this tab (someone else\'s link)', async () => {
    const h = harness();
    await expect(h.auth.completeSignIn(new URLSearchParams('id_token=x&state=y'))).rejects.toMatchObject({ reason: 'mismatch' });
  });

  it('can be used only once', async () => {
    const h = harness([json(session(1))]);
    const { params } = await startAndReturn(h);
    await h.auth.completeSignIn(params);
    await expect(h.auth.completeSignIn(params)).rejects.toMatchObject({ reason: 'mismatch' });
  });

  it('expires after ten minutes', async () => {
    const h = harness();
    const { params } = await startAndReturn(h);
    h.tick(601);
    await expect(h.auth.completeSignIn(params)).rejects.toMatchObject({ reason: 'expired' });
  });

  it('reports cancelling at Google as cancelled', async () => {
    const h = harness();
    await h.auth.startSignIn();
    await expect(h.auth.completeSignIn(new URLSearchParams('error=access_denied&state=x'))).rejects.toBeInstanceOf(SignInError);
  });

  it('reports a refused exchange and no network differently', async () => {
    const refused = harness([json({ error: 'invalid_grant' }, 400)]);
    await expect(refused.auth.completeSignIn((await startAndReturn(refused)).params)).rejects.toMatchObject({ reason: 'rejected' });
    const offline = harness([() => { throw new TypeError('Failed to fetch'); }]);
    await expect(offline.auth.completeSignIn((await startAndReturn(offline)).params)).rejects.toMatchObject({ reason: 'offline' });
  });
});

describe('staying signed in', () => {
  async function signedIn(responses: Array<() => Response>, expiresIn = 3600) {
    const h = harness([json(session(1, expiresIn)), ...responses]);
    await h.auth.completeSignIn((await startAndReturn(h)).params);
    return h;
  }

  it('counts the token’s lifetime on this device, ignoring a server time that disagrees with its clock', async () => {
    // The server says the token expired long ago (its clock and ours differ by hours).
    const h = harness([json({ ...session(1), expires_at: 1 })]);
    await h.auth.completeSignIn((await startAndReturn(h)).params);
    expect(await h.auth.getAccessToken()).toBe('access-1');
    expect(h.calls).toHaveLength(1);
  });

  it('refreshes shortly before the access token expires, rotating the refresh token', async () => {
    const h = await signedIn([json(session(2))]);
    h.tick(3600 - 59);
    expect(await h.auth.getAccessToken()).toBe('access-2');
    expect(bodyOf(must(h.calls[1], 'the refresh call'))).toEqual({ refresh_token: 'refresh-1' });
    expect(h.storage.map.get('graphinity:refresh')).toBe('refresh-2');
  });

  it('refreshes once even when many requests ask at the same moment', async () => {
    const h = await signedIn([json(session(2))]);
    h.tick(3600);
    const tokens = await Promise.all([h.auth.getAccessToken(), h.auth.getAccessToken(), h.auth.getAccessToken()]);
    expect(tokens).toEqual(['access-2', 'access-2', 'access-2']);
    expect(h.calls).toHaveLength(2);
  });

  it('signs out when the refresh token is refused', async () => {
    const h = await signedIn([json({ error: 'invalid_grant' }, 400)]);
    h.tick(3600);
    expect(await h.auth.getAccessToken()).toBeNull();
    expect(h.auth.hasSession()).toBe(false);
  });

  it('keeps the session when Supabase has a temporary problem (5xx, rate limit)', async () => {
    for (const status of [500, 503, 429]) {
      const h = await signedIn([json({ error: 'temporarily_unavailable' }, status), json(session(2))]);
      h.tick(3600);
      expect(await h.auth.getAccessToken(), String(status)).toBeNull();
      expect(h.auth.hasSession(), String(status)).toBe(true);
      expect(await h.auth.getAccessToken(), String(status)).toBe('access-2');
    }
  });

  it('keeps the session when offline, so it works again once back online', async () => {
    const h = await signedIn([() => { throw new TypeError('Failed to fetch'); }, json(session(2))]);
    h.tick(3600);
    expect(await h.auth.getAccessToken()).toBeNull();
    expect(h.auth.hasSession()).toBe(true);
    expect(await h.auth.getAccessToken()).toBe('access-2');
  });

  it('signing out forgets everything and tells Supabase', async () => {
    const h = await signedIn([() => new Response(null, { status: 204 })]);
    await h.auth.signOut();
    expect(h.storage.map.size).toBe(0);
    expect(await h.auth.getAccessToken()).toBeNull();
    expect(must(h.calls[1], 'the logout call').url).toBe('https://proj.supabase.co/auth/v1/logout');
  });

  it('signing out while a refresh is on its way stays signed out', async () => {
    let answer: (r: Response) => void = () => {};
    const slow = new Promise<Response>(r => { answer = r; });
    // The harness resolves whatever a response maker returns, so a promise holds the refresh open.
    const h = await signedIn([() => slow as unknown as Response, () => new Response(null, { status: 204 })]);
    h.tick(3600);
    const refresh = h.auth.getAccessToken();
    await h.auth.signOut();
    answer(json(session(2))());
    expect(await refresh).toBeNull();
    expect(h.auth.hasSession()).toBe(false);
    expect(h.storage.map.size).toBe(0);
  });

  it('signing out after a reload still ends the session at Supabase', async () => {
    const h = harness([json(session(2)), () => new Response(null, { status: 204 })]);
    // A reload: only the refresh token survives, in session storage.
    h.storage.setItem('graphinity:refresh', 'refresh-1');
    await h.auth.signOut();
    const logout = must(h.calls[1], 'the logout call');
    expect(logout.url).toBe('https://proj.supabase.co/auth/v1/logout');
    expect(new Headers(logout.init.headers).get('authorization')).toBe('Bearer access-2');
    expect(h.storage.map.size).toBe(0);
  });

  it('a refusal for an old session doesn’t sign out the new one', async () => {
    let answer: (r: Response) => void = () => {};
    const slow = new Promise<Response>(r => { answer = r; });
    const h = await signedIn([() => slow as unknown as Response, () => new Response(null, { status: 204 })]);
    h.tick(3600);
    const refresh = h.auth.getAccessToken();
    await h.auth.signOut();
    h.responses.push(json(session(3)));
    await h.auth.completeSignIn((await startAndReturn(h)).params);
    answer(json({ error: 'invalid_grant' }, 400)());
    expect(await refresh).toBeNull();
    expect(await h.auth.getAccessToken()).toBe('access-3');
  });
});
