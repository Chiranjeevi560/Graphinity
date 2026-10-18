// Loading what a screen shows, the same way on every screen: one request,
// a clear failure with a way to try again, and a retry by itself when the
// device comes back online, so nobody has to notice and reload.
import { useCallback, useEffect, useState } from 'react';
import { ApiError, type RequestOptions } from './lib/api.ts';
import { useRetryWhenOnline } from './lib/retry.ts';
import { api } from './session.tsx';

export interface Load<T> {
  /** Null while loading or after a failure. */
  data: T | null;
  error: ApiError | null;
  retry: () => void;
  /** Replace what was loaded (after the screen changed it, or reloaded it). */
  setData: (data: T) => void;
}

const asApiError = (err: unknown) => err instanceof ApiError ? err : new ApiError(0, 'unknown', 'Something went wrong. Try again in a minute.');

export function useLoad<T>(path: string, signedIn?: RequestOptions['signedIn']): Load<T> {
  const [result, setResult] = useState<{ path: string; data: T | null; error: ApiError | null } | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    api<T>(path, signedIn === undefined ? {} : { signedIn }).then(
      data => { if (live) setResult({ path, data, error: null }); },
      (err: unknown) => { if (live) setResult({ path, data: null, error: asApiError(err) }); },
    );
    return () => { live = false; };
  }, [path, signedIn, attempt]);

  // An answer for another path (the screen moved on) counts as still loading.
  const current = result?.path === path ? result : null;
  const error = current?.error ?? null;

  const retry = useCallback(() => {
    setResult(null);
    setAttempt(a => a + 1);
  }, []);

  useRetryWhenOnline(error, retry);

  const setData = useCallback((data: T) => { setResult({ path, data, error: null }); }, [path]);
  return { data: current?.data ?? null, error, retry, setData };
}
