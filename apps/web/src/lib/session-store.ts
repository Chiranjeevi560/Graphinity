// Who is signed in, and whether they have a profile yet, as a small store the
// React tree subscribes to. Kept out of React so it can be tested directly.
import { ApiError, type Api } from './api.ts';
import type { Auth } from './auth.ts';

export interface Profile {
  handle: string;
  country: { code: string; name: string };
  fields: Array<{ slug: string; name: string }>;
  joined: string;
  handleChangeAvailableAt?: string | null;
  /** From /me only: may review reports. */
  moderator?: boolean;
  /** From /me only: can read but not post. */
  blocked?: boolean;
}

export type SessionState =
  | { status: 'loading' }
  | { status: 'signedOut' }
  | { status: 'needsProfile' }
  | { status: 'ready'; profile: Profile }
  | { status: 'unreachable'; error: ApiError };

export function createSessionStore(deps: { auth: Auth; api: Api }) {
  let state: SessionState = { status: 'loading' };
  const listeners = new Set<() => void>();
  // Each reload gets a number; only the newest may change the state, so a
  // slow, older answer can't overwrite what happened since (e.g. signing out).
  let latest = 0;

  function set(next: SessionState) {
    state = next;
    listeners.forEach(l => { l(); });
  }

  async function reload(): Promise<void> {
    const mine = ++latest;
    if (!deps.auth.hasSession()) { set({ status: 'signedOut' }); return; }
    let next: SessionState;
    try {
      const me = await deps.api<{ profile: Profile | null; moderator?: boolean; blocked?: boolean }>('/me', { signedIn: true });
      next = me.profile
        ? { status: 'ready', profile: { ...me.profile, moderator: me.moderator === true, blocked: me.blocked === true } }
        : { status: 'needsProfile' };
    } catch (err) {
      next = err instanceof ApiError && err.code === 'signed_out'
        ? { status: 'signedOut' }
        : { status: 'unreachable', error: err instanceof ApiError ? err : new ApiError(0, 'unknown', 'Something went wrong. Try again in a minute.') };
    }
    if (mine === latest) set(next);
  }

  // Signing in or out anywhere reloads the state.
  deps.auth.subscribe(() => { void reload(); });

  return {
    getState: () => state,
    // Plain functions, not methods: React and callers pass them around on their own.
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    reload,
    setProfile: (profile: Profile) => {
      latest++; // anything still in flight is now out of date
      // An edit returns the profile alone; who may moderate doesn't change with it.
      const previous = state.status === 'ready' ? state.profile : null;
      set({ status: 'ready', profile: { moderator: previous?.moderator === true, blocked: previous?.blocked === true, ...profile } });
    },
  };
}

export type SessionStore = ReturnType<typeof createSessionStore>;
