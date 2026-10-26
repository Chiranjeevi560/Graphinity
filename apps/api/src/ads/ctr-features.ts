// What the ad click model reads (docs/adr/0022-advertising-platform.md part 5),
// one function for training and serving, so a model is served exactly the
// features it learned from: an impression's campaign, ad, placement, page
// topic and hour, with the campaign-by-topic and campaign-by-placement
// crosses a per-campaign average can't see. Nothing about the person.
export const AD_CTR = 'ad-ctr';

export interface CtrContext {
  campaign: string;
  creative: string;
  placement: string;
  field: string | null;
  hour: number;
}

export function ctrFeatures(e: CtrContext): string[] {
  const f = e.field ?? '-';
  return [
    `c:${e.campaign}`,
    `cr:${e.creative}`,
    `p:${e.placement}`,
    `f:${f}`,
    `h:${String(e.hour)}`,
    `cf:${e.campaign}:${f}`,
    `cp:${e.campaign}:${e.placement}`,
  ];
}
