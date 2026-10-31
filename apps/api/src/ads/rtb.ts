// Outside bids against Graphinity's own (docs/adr/0022-advertising-platform.md
// part 9a). Pure. Each slot's floor is what Graphinity's own winner for it is
// worth per thousand impressions (its bid × predicted click rate), or the
// reserve if it has none: an outside ad takes a slot only by paying more than
// our own ad would earn there. The highest valid bid for a slot above its floor
// wins and pays the second price plus a hundredth (OpenRTB "second price plus",
// at = 2), never more than it bid.
import { createHmac } from 'node:crypto';
import type { Win } from './auction.ts';
import type { PartnerBid } from './openrtb.ts';

/** Micro-units per impression → price per thousand impressions, in whole currency units. */
export const cpmOf = (microsPerImpression: number) => microsPerImpression / 1000;
/** Price per thousand → micro-units per impression. */
export const microsOfCpm = (cpm: number) => Math.round(cpm * 1000);

export const PRICE_INCREMENT = 0.01;

/** The floor for each slot, best slot first. */
export function floors(wins: readonly Win[], slots: number, reserveCpm: number): number[] {
  return Array.from({ length: slots }, (_, i) => {
    const own = wins[i];
    return Math.max(reserveCpm, own ? cpmOf(own.value) : 0);
  });
}

export type SlotOutcome =
  { kind: 'own'; win: Win } | { kind: 'partner'; bid: PartnerBid & { partner: string }; priceMicros: number };

/**
 * Who fills each slot: a partner whose bid for that impression (imp id = slot + 1) beats the
 * floor, else Graphinity's own winner, else nobody. A partner fills one slot at most.
 */
export function merge(
  wins: readonly Win[],
  bids: ReadonlyArray<PartnerBid & { partner: string }>,
  slotFloors: readonly number[],
): SlotOutcome[] {
  const out: SlotOutcome[] = [];
  const used = new Set<string>();
  let ownNext = 0;
  slotFloors.forEach((sent, i) => {
    // The own ad a partner would displace here is the next one not yet placed (after a partner
    // takes a slot, ours move down), so the floor is what that one is worth, at least what was sent.
    const own = wins[ownNext];
    const floor = Math.max(sent, own ? cpmOf(own.value) : 0);
    const here = bids
      .filter(b => b.impid === String(i + 1) && !used.has(b.partner) && b.price > floor)
      .sort((a, b) => b.price - a.price || (a.partner < b.partner ? -1 : 1));
    const [best, second] = here;
    if (best) {
      used.add(best.partner);
      const pay = Math.min(best.price, Math.max(floor, second?.price ?? 0) + PRICE_INCREMENT);
      out.push({ kind: 'partner', bid: best, priceMicros: Math.max(1, microsOfCpm(pay)) });
      return;
    }
    if (own) {
      out.push({ kind: 'own', win: own });
      ownNext += 1;
    }
  });
  return out;
}

/**
 * A reader's extended id for partners: rotates every UTC month and whenever their ad identity
 * does (turning personalized ads off), and differs per device unless they allow one profile
 * across devices. Says nothing about them by itself; HMAC-SHA256, 128 bits, base64url.
 */
export function eid(secret: Buffer, adId: string, at: number, deviceKey: string | null): string {
  const month = new Date(at).toISOString().slice(0, 7);
  return createHmac('sha256', secret)
    .update(['eid', adId, month, deviceKey ?? '*'].join('\u0000'))
    .digest()
    .subarray(0, 16)
    .toString('base64url');
}
