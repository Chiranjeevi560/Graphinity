// Asking outside bidders (docs/adr/0022-advertising-platform.md part 9a): one
// OpenRTB request to each enabled partner, all at once, and whatever valid
// bids arrive within TMAX_MS. Three guards keep a slow or broken partner from
// slowing Graphinity's pages:
// - a timeout: each request is aborted at TMAX_MS, so a page waits at most
//   that long however many partners there are;
// - a bulkhead: at most MAX_IN_FLIGHT partner requests at once across the
//   server; past that, partners simply aren't asked;
// - a circuit breaker per partner: after BREAKER_FAILURES failures in a row
//   it isn't asked for BREAKER_COOLDOWN_MS.
// Partner addresses are https only and never an IP literal or a local name
// (checked when they're stored, migration 0038); responses over
// MAX_RESPONSE_BYTES are dropped.
import { parseBidResponse, TMAX_MS, type PartnerBid } from './openrtb.ts';

export const MAX_IN_FLIGHT = 64;
export const BREAKER_FAILURES = 5;
export const BREAKER_COOLDOWN_MS = 30_000;
export const MAX_RESPONSE_BYTES = 64 * 1024;

export interface Partner {
  id: string;
  endpoint: string;
}

export type Fetcher = (
  url: string,
  init: { method: 'POST'; headers: Record<string, string>; body: string; signal: AbortSignal; redirect: 'error' },
) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

interface Breaker {
  failures: number;
  openUntil: number;
}

export interface Exchange {
  /** Valid bids from every partner that answered in time, each tagged with its partner. */
  ask(partners: readonly Partner[], request: Record<string, unknown>): Promise<Array<PartnerBid & { partner: string }>>;
  /** For tests and the ops page: how many requests are in flight, and which partners are skipped. */
  state(): { inFlight: number; open: string[] };
}

export function createExchange(fetcher: Fetcher, now: () => number = Date.now): Exchange {
  let inFlight = 0;
  const breakers = new Map<string, Breaker>();
  const failed = (id: string) => {
    const b = breakers.get(id) ?? { failures: 0, openUntil: 0 };
    b.failures += 1;
    if (b.failures >= BREAKER_FAILURES) {
      b.openUntil = now() + BREAKER_COOLDOWN_MS;
      b.failures = 0;
    }
    breakers.set(id, b);
  };

  async function one(p: Partner, body: string, request: Record<string, unknown>) {
    inFlight += 1;
    try {
      const res = await fetcher(p.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-openrtb-version': '2.6' },
        body,
        signal: AbortSignal.timeout(TMAX_MS),
        // A partner can't send the request on to somewhere else.
        redirect: 'error',
      });
      // 204: no bid, a normal answer.
      if (res.status === 204) {
        breakers.delete(p.id);
        return [];
      }
      if (res.status !== 200) throw new Error('bad status');
      if (Number(res.headers.get('content-length') ?? 0) > MAX_RESPONSE_BYTES) throw new Error('too large');
      const raw = await res.text();
      if (raw.length > MAX_RESPONSE_BYTES) throw new Error('too large');
      breakers.delete(p.id);
      return parseBidResponse(request, JSON.parse(raw) as unknown).map(b => ({ ...b, partner: p.id }));
    } catch {
      failed(p.id);
      return [];
    } finally {
      inFlight -= 1;
    }
  }

  return {
    async ask(partners, request) {
      const body = JSON.stringify(request);
      const asked: Array<Promise<Array<PartnerBid & { partner: string }>>> = [];
      for (const p of partners) {
        if ((breakers.get(p.id)?.openUntil ?? 0) > now()) continue;
        // one() counts itself in before its first await, so inFlight is current here.
        if (inFlight >= MAX_IN_FLIGHT) break;
        asked.push(one(p, body, request));
      }
      return (await Promise.all(asked)).flat();
    },
    state: () => ({
      inFlight,
      open: [...breakers].filter(([, b]) => b.openUntil > now()).map(([id]) => id),
    }),
  };
}
