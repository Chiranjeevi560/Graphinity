// Signing in with Google through Supabase Auth, without Supabase's client
// library: the few calls we need are small, and every dependency is
// something to audit and download.
//
// Where things are kept:
// - The access token (proves who you are to our API) lives only in memory.
// - The refresh token (gets a new access token) lives in sessionStorage, so a
//   reload keeps you signed in but closing the tab signs you out. Never in
//   localStorage, which outlives the tab and is shared by every tab.
// - The PKCE verifier and our own state value live in sessionStorage only
//   between leaving for Google and coming back, and are deleted on return.
import { challengeFor, randomToken } from './pkce.ts';

export interface AuthDeps {
  supabaseUrl: string;
  /** Supabase publishable key. Public by design; identifies the project. */
  supabaseKey: string;
  siteOrigin: string;
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  fetch: typeof fetch;
  /** Leave the site for Google. */
  redirect: (url: string) => void;
  /** Seconds since the epoch. */
  now: () => number;
}

export type SignInFailure = 'cancelled' | 'mismatch' | 'expired' | 'rejected' | 'offline';

export class SignInError extends Error {
  override name = 'SignInError';
  readonly reason: SignInFailure;
  constructor(reason: SignInFailure) {
    super(reason);
    this.reason = reason;
  }
}

export const signInMessages: Record<SignInFailure, string> = {
  cancelled: 'Sign-in was cancelled. You can try again whenever you’re ready.',
  mismatch: 'This sign-in didn’t start on this page, so it was stopped for your safety. Try again.',
  expired: 'This sign-in took too long and expired. Try again.',
  rejected: 'Sign-in didn’t finish. Try again.',
  offline: 'You seem to be offline. Check your connection and try again.',
};

const PENDING_KEY = 'graphinity:signin';
const REFRESH_KEY = 'graphinity:refresh';
const PENDING_MAX_AGE = 10 * 60; // seconds
/** Refresh this long before the access token expires. */
const EARLY_REFRESH = 60;

interface Pending {
  verifier: string;
  state: string;
  returnTo: string;
  startedAt: number;
}

interface TokenResponse {
  access_token: string;
  expires_at?: number;
  expires_in: number;
  refresh_token: string;
}

export function createAuth(deps: AuthDeps) {
  const { storage } = deps;
  let access: { token: string; expiresAt: number } | null = null;
  let refreshing: Promise<string | null> | null = null;
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach(l => l());

  const authHeaders = { apikey: deps.supabaseKey, 'content-type': 'application/json' };

  function keep(session: TokenResponse) {
    const expiresAt = session.expires_at ?? deps.now() + session.expires_in;
    access = { token: session.access_token, expiresAt };
    storage.setItem(REFRESH_KEY, session.refresh_token);
  }

  function forget() {
    const had = access !== null || storage.getItem(REFRESH_KEY) !== null;
    access = null;
    storage.removeItem(REFRESH_KEY);
    if (had) notify();
  }

  async function postToken(grant: 'pkce' | 'refresh_token', body: object): Promise<Response> {
    return deps.fetch(`${deps.supabaseUrl}/auth/v1/token?grant_type=${grant}`, {
      method: 'POST', headers: authHeaders, body: JSON.stringify(body),
    });
  }

  return {
    /** Leaves for Google. `returnTo` is a path on this site to come back to. */
    async startSignIn(returnTo = '/') {
      const verifier = randomToken();
      const state = randomToken(16);
      const pending: Pending = { verifier, state, returnTo: safePath(returnTo), startedAt: deps.now() };
      storage.setItem(PENDING_KEY, JSON.stringify(pending));
      const callback = new URL('/auth/callback', deps.siteOrigin);
      callback.searchParams.set('state', state);
      const url = new URL('/auth/v1/authorize', deps.supabaseUrl);
      url.searchParams.set('provider', 'google');
      url.searchParams.set('redirect_to', callback.toString());
      url.searchParams.set('code_challenge', await challengeFor(verifier));
      url.searchParams.set('code_challenge_method', 's256');
      deps.redirect(url.toString());
    },

    /**
     * Finishes sign-in from the callback address. The caller must already
     * have removed the code from the address bar; this only reads the
     * values it was given.
     */
    async completeSignIn(params: URLSearchParams): Promise<{ returnTo: string }> {
      const raw = storage.getItem(PENDING_KEY);
      // Single use: gone whether this succeeds or not.
      storage.removeItem(PENDING_KEY);
      if (params.get('error')) throw new SignInError('cancelled');
      const code = params.get('code');
      const state = params.get('state');
      if (!raw || !code || !state) throw new SignInError('mismatch');
      let pending: Pending;
      try { pending = JSON.parse(raw) as Pending; } catch { throw new SignInError('mismatch'); }
      // Our own state must match what this tab stored before leaving. That
      // stops someone feeding us a sign-in they started (login CSRF).
      if (!constantTimeEqual(pending.state, state)) throw new SignInError('mismatch');
      if (deps.now() - pending.startedAt > PENDING_MAX_AGE) throw new SignInError('expired');

      let res: Response;
      try {
        res = await postToken('pkce', { auth_code: code, code_verifier: pending.verifier });
      } catch {
        throw new SignInError('offline');
      }
      if (!res.ok) throw new SignInError('rejected');
      keep(await res.json() as TokenResponse);
      notify();
      return { returnTo: safePath(pending.returnTo) };
    },

    /** A valid access token, refreshed if needed, or null when signed out. */
    async getAccessToken({ forceRefresh = false } = {}): Promise<string | null> {
      if (!forceRefresh && access && access.expiresAt - deps.now() > EARLY_REFRESH) return access.token;
      const refreshToken = storage.getItem(REFRESH_KEY);
      if (!refreshToken) { forget(); return null; }
      // One refresh at a time: refresh tokens are single use, so two parallel
      // refreshes would sign the person out.
      refreshing ??= (async () => {
        try {
          const res = await postToken('refresh_token', { refresh_token: refreshToken });
          // Only Supabase saying the refresh token is no good ends the
          // session. A server error or a rate limit is temporary: keep the
          // refresh token and try again on the next request.
          if (res.status === 400 || res.status === 401 || res.status === 403) { forget(); return null; }
          if (!res.ok) return null;
          keep(await res.json() as TokenResponse);
          return access!.token;
        } catch {
          // Offline: keep the refresh token for next time, but no token now.
          return null;
        } finally {
          refreshing = null;
        }
      })();
      return refreshing;
    },

    hasSession(): boolean {
      return access !== null || storage.getItem(REFRESH_KEY) !== null;
    },

    async signOut() {
      const token = access?.token;
      forget();
      if (token) {
        // Best effort: also ends the session on Supabase's side.
        await deps.fetch(`${deps.supabaseUrl}/auth/v1/logout`, {
          method: 'POST', headers: { ...authHeaders, authorization: `Bearer ${token}` },
        }).catch(() => {});
      }
    },

    /** After the account is deleted there is nothing to sign out of. */
    clear: forget,

    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

export type Auth = ReturnType<typeof createAuth>;

/** Only paths on this site; anything else could send people somewhere hostile. */
export function safePath(path: string): string {
  return /^\/(?![/\\])[^\s]*$/.test(path) ? path : '/';
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
