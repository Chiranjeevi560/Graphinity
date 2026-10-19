// Who is signed in, and whether they have a profile yet. One instance for
// the whole app.
import { createContext, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import { createApi, type Api } from './lib/api.ts';
import { createAuth, type Auth } from './lib/auth.ts';
import { useRetryWhenOnline } from './lib/retry.ts';
import { createSessionStore, type Profile, type SessionState } from './lib/session-store.ts';
import { site } from './site-settings.ts';

export type { Profile, SessionState } from './lib/session-store.ts';

/** sessionStorage can throw (blocked storage, some private modes); then sign-in lasts for the page only. */
function tabStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> {
  const memory = new Map<string, string>();
  return {
    getItem: k => {
      try {
        return sessionStorage.getItem(k);
      } catch {
        return memory.get(k) ?? null;
      }
    },
    setItem: (k, v) => {
      try {
        sessionStorage.setItem(k, v);
      } catch {
        memory.set(k, v);
      }
    },
    removeItem: k => {
      try {
        sessionStorage.removeItem(k);
      } catch {
        memory.delete(k);
      }
    },
  };
}

export const auth: Auth = createAuth({
  supabaseUrl: site.supabaseUrl,
  supabaseKey: site.supabasePublishableKey,
  googleClientId: site.googleClientId,
  googleAuthorizeUrl: site.googleAuthorizeUrl,
  siteOrigin: location.origin,
  storage: tabStorage(),
  fetch: (...args) => fetch(...args),
  redirect: url => {
    location.assign(url);
  },
  now: () => Math.floor(Date.now() / 1000),
});

export const api: Api = createApi({
  origin: site.apiOrigin,
  auth,
  fetch: (...args) => fetch(...args),
  online: () => navigator.onLine,
});

const store = createSessionStore({ auth, api });

interface SessionValue {
  state: SessionState;
  reload: () => Promise<void>;
  setProfile: (profile: Profile) => void;
}

/** Ask the server again who is signed in (after it couldn't be reached). */
export const retrySession = () => {
  void store.reload();
};

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const state = useSyncExternalStore(store.subscribe, store.getState);
  useEffect(() => {
    void store.reload();
  }, []);
  // Couldn't reach the server to learn who's signed in: ask again once back online.
  useRetryWhenOnline(state.status === 'unreachable' ? state.error : null, retrySession);
  const value = useMemo<SessionValue>(() => ({ state, reload: store.reload, setProfile: store.setProfile }), [state]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession outside SessionProvider');
  return value;
}
