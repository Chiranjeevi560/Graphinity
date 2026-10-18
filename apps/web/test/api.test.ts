import { describe, expect, it } from 'vitest';
import { ApiError, createApi } from '../src/lib/api.ts';
import type { Auth } from '../src/lib/auth.ts';
import { must } from './must.ts';

function fakeAuth(tokens: Array<string | null>, session = false) {
  let cleared = false;
  const auth = {
    getAccessToken: () => Promise.resolve(tokens.shift() ?? null),
    hasSession: () => session,
    clear: () => { cleared = true; },
  } as unknown as Auth;
  return { auth, get cleared() { return cleared; } };
}

function fetchSequence(responses: Array<() => Response>) {
  const seen: Array<{ url: string; auth: string | undefined }> = [];
  const f = ((url: string, init: RequestInit) => {
    seen.push({ url, auth: (init.headers as Record<string, string>).authorization });
    return Promise.resolve(must(responses.shift(), `a response for ${url}`)());
  }) as unknown as typeof fetch;
  return { f, seen };
}

const json = (body: object | null, status = 200) => () => new Response(body === null ? null : JSON.stringify(body), { status });

describe('api', () => {
  it('sends the access token on signed-in requests', async () => {
    const { auth } = fakeAuth(['tok-1']);
    const { f, seen } = fetchSequence([json({ profile: null })]);
    const api = createApi({ origin: 'https://api.test', auth, fetch: f });
    expect(await api('/me', { signedIn: true })).toEqual({ profile: null });
    expect(seen[0]).toEqual({ url: 'https://api.test/me', auth: 'Bearer tok-1' });
  });

  it('on 401 refreshes once and retries once', async () => {
    const { auth } = fakeAuth(['old', 'new']);
    const { f, seen } = fetchSequence([json({ error: 'signed_out' }, 401), json({ ok: true })]);
    const api = createApi({ origin: 'https://api.test', auth, fetch: f });
    expect(await api('/me', { signedIn: true })).toEqual({ ok: true });
    expect(seen.map(s => s.auth)).toEqual(['Bearer old', 'Bearer new']);
  });

  it('clears the session if the retried request is still refused', async () => {
    const fa = fakeAuth(['old', 'new']);
    const { f } = fetchSequence([json({ error: 'signed_out', message: 'You’re signed out.' }, 401), json({ error: 'signed_out', message: 'You’re signed out.' }, 401)]);
    const api = createApi({ origin: 'https://api.test', auth: fa.auth, fetch: f });
    await expect(api('/me', { signedIn: true })).rejects.toMatchObject({ status: 401, code: 'signed_out' });
    expect(fa.cleared).toBe(true);
  });

  it('passes the server’s plain-words message and extra details through', async () => {
    const { auth } = fakeAuth(['t']);
    const { f } = fetchSequence([json({ error: 'handle_change_too_soon', message: 'You changed your name recently.', availableAt: '2026-10-24T10:00:00.000Z' }, 409)]);
    const err = await createApi({ origin: 'https://api.test', auth, fetch: f })('/me/profile', { method: 'PATCH', body: {}, signedIn: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 409, code: 'handle_change_too_soon', message: 'You changed your name recently.', details: { availableAt: '2026-10-24T10:00:00.000Z' } });
  });

  it('says plainly when the network is down', async () => {
    const { auth } = fakeAuth([]);
    const f = (() => Promise.reject(new TypeError('Failed to fetch'))) as unknown as typeof fetch;
    await expect(createApi({ origin: 'https://api.test', auth, fetch: f })('/meta')).rejects.toMatchObject({ code: 'offline', message: 'You seem to be offline. Check your connection and try again.' });
  });

  it('says "offline", not "signed out", when the token could not be refreshed for lack of network', async () => {
    const auth = { getAccessToken: () => Promise.resolve(null), hasSession: () => true, clear: () => {} } as unknown as Auth;
    const { f, seen } = fetchSequence([]);
    await expect(createApi({ origin: 'https://api.test', auth, fetch: f })('/me', { signedIn: true })).rejects.toMatchObject({ code: 'offline' });
    expect(seen).toHaveLength(0);
  });

  it('does not call the server at all when a signed-in request has no session', async () => {
    const { auth } = fakeAuth([null]);
    const { f, seen } = fetchSequence([]);
    await expect(createApi({ origin: 'https://api.test', auth, fetch: f })('/me', { signedIn: true })).rejects.toMatchObject({ code: 'signed_out' });
    expect(seen).toHaveLength(0);
  });

  it('sends the sign-in on public reads when there is one, and reads as a visitor when not', async () => {
    const signedIn = fakeAuth(['tok-9'], true);
    const one = fetchSequence([json({ ok: true })]);
    await createApi({ origin: 'https://api.test', auth: signedIn.auth, fetch: one.f })('/questions/1', { signedIn: 'if-possible' });
    expect(one.seen[0]?.auth).toBe('Bearer tok-9');
    const visitor = fakeAuth([], false);
    const two = fetchSequence([json({ ok: true })]);
    await createApi({ origin: 'https://api.test', auth: visitor.auth, fetch: two.f })('/questions/1', { signedIn: 'if-possible' });
    expect(two.seen[0]?.auth).toBeUndefined();
  });
});
