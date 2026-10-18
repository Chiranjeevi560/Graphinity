// Signing in with Google, then handing Google's proof to Supabase Auth,
// without either company's script library: the few calls we need are small,
// and every dependency is something to audit and download.
//
// Google returns to this site, not to Supabase, so Google's screen names
// this site ("Sign in to graphinity.pages.dev"), not the Supabase project.
// We ask only for "openid email": no name, no photo. Supabase needs the
// email to keep the account; Graphinity itself never reads or shows it.
//
// Google sends back a signed ID token. It can't be used without the random
// nonce this tab made before leaving: Google only ever sees the nonce's
// hash, and Supabase checks the token against the raw nonce we send.
//
// Where things are kept:
// - The access token (proves who you are to our API) lives only in memory.
// - The refresh token (gets a new access token) lives in sessionStorage, so a
//   reload keeps you signed in but closing the tab signs you out. Never in
//   localStorage, which outlives the tab and is shared by every tab.
// - The nonce and our own state value live in sessionStorage only between
//   leaving for Google and coming back, and are deleted on return.
import { randomToken, sha256Hex } from './random.ts';

export interface AuthDeps {
  supabaseUrl: string;
  /** Supabase publishable key. Public by design; identifies the project. */
  supabaseKey: string;
  /** The OAuth client ID from Google Cloud. Public by design. */
  googleClientId: string;
  /** Google's sign-in page (the local stand-in's while developing). */
  googleAuthorizeUrl: string;
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
  nonce: string;
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
  const notify = () => { listeners.forEach(l => { l(); }); };

  const authHeaders = { apikey: deps.supabaseKey, 'content-type': 'application/json' };

  function keep(session: TokenResponse): string {
    // The lifetime, counted on this device's clock: comparing the server's
    // expiry time with a device clock that is off would refresh constantly.
    const expiresAt = deps.now() + session.expires_in;
    access = { token: session.access_token, expiresAt };
    storage.setItem(REFRESH_KEY, session.refresh_token);
    return session.access_token;
  }

  // Bumped by every sign-out: a refresh started before it must not keep its result.
  let generation = 0;

  function forget() {
    generation += 1;
    const had = access !== null || storage.getItem(REFRESH_KEY) !== null;
    access = null;
    storage.removeItem(REFRESH_KEY);
    if (had) notify();
  }

  async function postToken(grant: 'id_token' | 'refresh_token', body: object): Promise<Response> {
    return deps.fetch(`${deps.supabaseUrl}/auth/v1/token?grant_type=${grant}`, {
      method: 'POST', headers: authHeaders, body: JSON.stringify(body),
    });
  }

  const auth = {
    /** Leaves for Google. `returnTo` is a path on this site to come back to. */
    async startSignIn(returnTo = '/') {
      const nonce = randomToken();
      const state = randomToken(16);
      const pending: Pending = { nonce, state, returnTo: safePath(returnTo), startedAt: deps.now() };
      storage.setItem(PENDING_KEY, JSON.stringify(pending));
      const url = new URL(deps.googleAuthorizeUrl);
      url.searchParams.set('client_id', deps.googleClientId);
      url.searchParams.set('redirect_uri', new URL('/auth/callback', deps.siteOrigin).toString());
      // An ID token in the address fragment, which never reaches any server.
      url.searchParams.set('response_type', 'id_token');
      url.searchParams.set('scope', 'openid email');
      url.searchParams.set('nonce', await sha256Hex(nonce));
      url.searchParams.set('state', state);
      // Always offer the account chooser, so a shared computer can't sign
      // the next person in as whoever used it last.
      url.searchParams.set('prompt', 'select_account');
      deps.redirect(url.toString());
    },

    /**
     * Finishes sign-in from what Google put in the callback address's
     * fragment. The caller must already have removed it from the address
     * bar; this only reads the values it was given.
     */
    async completeSignIn(params: URLSearchParams): Promise<{ returnTo: string }> {
      const raw = storage.getItem(PENDING_KEY);
      // Single use: gone whether this succeeds or not.
      storage.removeItem(PENDING_KEY);
      if (params.get('error')) throw new SignInError('cancelled');
      const idToken = params.get('id_token');
      const state = params.get('state');
      if (!raw || !idToken || !state) throw new SignInError('mismatch');
      let pending: Pending;
      try { pending = JSON.parse(raw) as Pending; } catch { throw new SignInError('mismatch'); }
      // Our own state must match what this tab stored before leaving. That
      // stops someone feeding us a sign-in they started (login CSRF).
      if (!constantTimeEqual(pending.state, state)) throw new SignInError('mismatch');
      if (deps.now() - pending.startedAt > PENDING_MAX_AGE) throw new SignInError('expired');

      let res: Response;
      try {
        res = await postToken('id_token', { provider: 'google', id_token: idToken, nonce: pending.nonce });
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
      const started = generation;
      refreshing ??= (async () => {
        try {
          const res = await postToken('refresh_token', { refresh_token: refreshToken });
          // Signed out (and maybe back in) meanwhile: this answer is about an old session.
          if (generation !== started) return null;
          // Only Supabase saying the refresh token is no good ends the
          // session. A server error or a rate limit is temporary: keep the
          // refresh token and try again on the next request.
          if (res.status === 400 || res.status === 401 || res.status === 403) { forget(); return null; }
          if (!res.ok) return null;
          const session = await res.json() as TokenResponse;
          // Signed out while this was on its way: keeping it would sign them back in.
          if (generation !== started) return null;
          return keep(session);
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
      // After a reload there's no access token in memory yet: get one, so the
      // session also ends at Supabase rather than lingering there.
      const token = access?.token ?? (storage.getItem(REFRESH_KEY) ? await auth.getAccessToken() : null);
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
  return auth;
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
