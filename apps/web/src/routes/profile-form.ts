// Shared by the welcome steps and the edit screen.
import { useEffect, useRef, useState } from 'react';
import type { FieldStatus } from '../components/Form.tsx';
import { ApiError } from '../lib/api.ts';
import { api } from '../session.tsx';

export interface Meta {
  fields: Array<{ slug: string; name: string }>;
  countries: Array<{ code: string; name: string }>;
}

let metaCache: Promise<Meta> | null = null;
export function loadMeta(): Promise<Meta> {
  metaCache ??= api<Meta>('/meta').catch(err => { metaCache = null; throw err; });
  return metaCache;
}

export function useMeta() {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    loadMeta().then(setMeta, err => setError(err instanceof ApiError ? err.message : 'Something went wrong. Try again in a minute.'));
  }, []);
  return { meta, error };
}

/** The region in the browser's language setting, if it's a country we know. Never leaves the device. */
export function guessCountry(codes: string[]): string {
  try {
    const region = new Intl.Locale(navigator.language).maximize().region;
    if (region && codes.includes(region)) return region;
  } catch {}
  return '';
}

/** Checks a name as the person types, once they pause. */
export function useHandleCheck(handle: string, current?: string) {
  const [status, setStatus] = useState<FieldStatus>(null);
  const [available, setAvailable] = useState(false);
  const latest = useRef(0);

  useEffect(() => {
    const value = handle.trim().toLowerCase();
    setAvailable(false);
    if (!value) { setStatus(null); return; }
    if (current !== undefined && value === current) { setStatus(null); setAvailable(true); return; }
    setStatus({ tone: 'neutral', text: 'Checking…' });
    const id = ++latest.current;
    const timer = setTimeout(async () => {
      try {
        const res = await api<{ available: boolean; message?: string }>(`/handles/${encodeURIComponent(value)}`, { signedIn: true });
        if (id !== latest.current) return;
        setAvailable(res.available);
        setStatus(res.available ? { tone: 'good', text: 'Available' } : { tone: 'bad', text: res.message ?? 'That name isn’t available.' });
      } catch (err) {
        if (id !== latest.current) return;
        setStatus({ tone: 'bad', text: err instanceof ApiError ? err.message : 'Couldn’t check that name. Try again.' });
      }
    }, 400);
    return () => clearTimeout(timer);
  }, [handle, current]);

  return { status, available, setStatus, setAvailable };
}
