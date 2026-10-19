// Shared by the welcome steps and the edit screen.
import { useCallback, useEffect, useState } from 'react';
import type { FieldStatus } from '../components/Form.tsx';
import { ApiError } from '../lib/api.ts';
import { api } from '../session.tsx';
import { useRetryWhenOnline } from '../lib/retry.ts';

export interface Meta {
  fields: Array<{ slug: string; name: string }>;
  countries: Array<{ code: string; name: string }>;
}

let metaCache: Promise<Meta> | null = null;
export function loadMeta(): Promise<Meta> {
  metaCache ??= api<Meta>('/meta').catch((err: unknown) => {
    metaCache = null;
    throw err;
  });
  return metaCache;
}

/** The topics and countries, shared and cached; tries again when asked, or once back online. */
export function useMeta() {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    loadMeta().then(
      m => {
        if (live) setMeta(m);
      },
      (err: unknown) => {
        if (live)
          setError(
            err instanceof ApiError ? err : new ApiError(0, 'unknown', 'Something went wrong. Try again in a minute.'),
          );
      },
    );
    return () => {
      live = false;
    };
  }, [attempt]);
  const retry = useCallback(() => {
    setError(null);
    setAttempt(a => a + 1);
  }, []);
  useRetryWhenOnline(error, retry);
  return { meta, error, retry };
}

/** The region in the browser's language setting, if it's a country we know. Never leaves the device. */
export function guessCountry(codes: string[]): string {
  try {
    const region = new Intl.Locale(navigator.language).maximize().region;
    return region && codes.includes(region) ? region : '';
  } catch {
    return ''; // An unusual language tag: no guess, the person picks.
  }
}

interface Check {
  value: string;
  available: boolean;
  status: FieldStatus;
}

/**
 * Checks a name as the person types, once they pause. Only the server's
 * answer is state; everything else is worked out from what's typed, so a
 * stale answer for an older value is never shown.
 */
export function useHandleCheck(handle: string, current?: string) {
  const value = handle.trim().toLowerCase();
  const [answer, setAnswer] = useState<Check | null>(null);
  const unchanged = current !== undefined && value === current;

  useEffect(() => {
    if (!value || unchanged) return;
    let live = true;
    const timer = setTimeout(() => {
      api<{ available: boolean; message?: string }>(`/handles/${encodeURIComponent(value)}`, { signedIn: true })
        .then(res => {
          if (live)
            setAnswer({
              value,
              available: res.available,
              status: res.available
                ? { tone: 'good', text: 'Available' }
                : { tone: 'bad', text: res.message ?? 'That name isn’t available.' },
            });
        })
        .catch((err: unknown) => {
          if (live)
            setAnswer({
              value,
              available: false,
              status: {
                tone: 'bad',
                text: err instanceof ApiError ? err.message : 'Couldn’t check that name. Try again.',
              },
            });
        });
    }, 400);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [value, unchanged]);

  /** The server refused the name on submit (someone took it meanwhile). */
  const refuse = (text: string) => {
    setAnswer({ value, available: false, status: { tone: 'bad', text } });
  };

  if (!value) return { status: null, available: false, refuse };
  if (unchanged) return { status: null, available: true, refuse };
  if (answer?.value === value) return { status: answer.status, available: answer.available, refuse };
  return { status: { tone: 'neutral', text: 'Checking…' } as FieldStatus, available: false, refuse };
}
