import { lazy, Suspense, useEffect, useState } from 'react';
import { api } from '../session.tsx';

const SponsoredSlot = lazy(() => import('./SponsoredSlot.tsx').then(m => ({ default: m.SponsoredSlot })));

interface AdStatus {
  on: boolean;
  partnerSignals: boolean;
}
// Once a visit: while advertising is off, that one small request is all it ever costs.
let status: Promise<AdStatus> | null = null;
const loadStatus = () =>
  (status ??= api<AdStatus>('/ads/status', { signedIn: 'if-possible' }).catch(() => ({
    on: false,
    partnerSignals: false,
  })));

/** The place for ads on a page: nothing at all, and no ad code, unless advertising is on. */
export function AdSlot(props: { placement: 'search' | 'question'; questionId?: string; query?: string }) {
  const [state, setState] = useState<AdStatus | null>(null);
  useEffect(() => {
    let live = true;
    void loadStatus().then(s => {
      if (live) setState(s);
    });
    return () => {
      live = false;
    };
  }, []);
  if (!state?.on) return null;
  return (
    <Suspense fallback={null}>
      <SponsoredSlot {...props} signals={state.partnerSignals} />
    </Suspense>
  );
}
