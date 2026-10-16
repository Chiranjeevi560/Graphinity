// Who is signed in, and whether they have a profile yet. One instance for
// the whole app.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ApiError, createApi, type Api } from './lib/api.ts';
import { createAuth, type Auth } from './lib/auth.ts';

export interface Profile {
  handle: string;
  country: { code: string; name: string };
  fields: Array<{ slug: string; name: string }>;
  joined: string;
  handleChangeAvailableAt?: string | null;
}

export type SessionState =
  | { status: 'loading' }
  | { status: 'signedOut' }
  | { status: 'needsProfile' }
  | { status: 'ready'; profile: Profile }
  | { status: 'unreachable'; message: string };

/** sessionStorage can throw (blocked storage, some private modes); then sign-in lasts for the page only. */
function tabStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> {
  const memory = new Map<string, string>();
  return {
    getItem: k => { try { return sessionStorage.getItem(k); } catch { return memory.get(k) ?? null; } },
    setItem: (k, v) => { try { sessionStorage.setItem(k, v); } catch { memory.set(k, v); } },
    removeItem: k => { try { sessionStorage.removeItem(k); } catch { memory.delete(k); } },
  };
}

export const auth: Auth = createAuth({
  supabaseUrl: import.meta.env.VITE_SUPABASE_URL,
  supabaseKey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
  siteOrigin: location.origin,
  storage: tabStorage(),
  fetch: (...args) => fetch(...args),
  redirect: url => location.assign(url),
  now: () => Math.floor(Date.now() / 1000),
});

export const api: Api = createApi({ origin: import.meta.env.VITE_API_ORIGIN, auth, fetch: (...args) => fetch(...args) });

interface SessionValue {
  state: SessionState;
  reload(): Promise<void>;
  setProfile(profile: Profile): void;
}

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SessionState>({ status: 'loading' });

  const reload = useCallback(async () => {
    if (!auth.hasSession()) { setState({ status: 'signedOut' }); return; }
    try {
      const { profile } = await api<{ profile: Profile | null }>('/me', { signedIn: true });
      setState(profile ? { status: 'ready', profile } : { status: 'needsProfile' });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'signed_out') setState({ status: 'signedOut' });
      else setState({ status: 'unreachable', message: err instanceof ApiError ? err.message : 'Something went wrong. Try again in a minute.' });
    }
  }, []);

  useEffect(() => {
    void reload();
    return auth.subscribe(() => { void reload(); });
  }, [reload]);

  const value = useMemo<SessionValue>(() => ({
    state,
    reload,
    setProfile: profile => setState({ status: 'ready', profile }),
  }), [state, reload]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession outside SessionProvider');
  return value;
}
