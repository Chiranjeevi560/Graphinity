import { useEffect } from 'react';
import { canRetry } from './api.ts';

/** After a failure that trying again can fix, try again by itself once the device is back online. */
export function useRetryWhenOnline(error: unknown, retry: () => void): void {
  const waiting = error !== null && error !== undefined && canRetry(error);
  useEffect(() => {
    if (!waiting) return;
    window.addEventListener('online', retry);
    return () => {
      window.removeEventListener('online', retry);
    };
  }, [waiting, retry]);
}
