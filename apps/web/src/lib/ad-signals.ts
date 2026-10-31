// Outside signals (Bidirectional spec), read in this browser only for someone who allowed partner
// sites. Nothing runs before that, each API is used only if this browser has it, and withdrawal
// leaves every group at once. Chrome has been withdrawing Privacy Sandbox APIs, so expect absence.

declare global {
  interface Navigator {
    joinAdInterestGroup?: (group: object, durationSeconds: number) => Promise<void>;
    clearOriginJoinedAdInterestGroups?: (owner: string) => Promise<void>;
    globalPrivacyControl?: boolean;
  }
  interface Document {
    browsingTopics?: () => Promise<Array<{ topic: number }>>;
  }
}

const GROUP_DAYS = 30;

/** Words from an ad link's utm_term on arrival. Search engines don't send a query in a referrer. */
export function landingQuery(search: string): string | null {
  const term = new URLSearchParams(search).get('utm_term');
  return term ? term.slice(0, 200) : null;
}

export async function browserTopics(doc: Document = document): Promise<number[]> {
  if (!doc.browsingTopics) return [];
  try {
    return (await doc.browsingTopics()).map(t => t.topic).slice(0, 16);
  } catch {
    // Blocked by the browser's own settings: treated as having no topics.
    return [];
  }
}

export async function joinProductIntent(
  productSlug: string,
  origin: string,
  nav: Navigator = navigator,
): Promise<boolean> {
  if (!nav.joinAdInterestGroup || nav.globalPrivacyControl) return false;
  try {
    await nav.joinAdInterestGroup(
      {
        owner: origin,
        name: `product_intent_${productSlug}`,
        biddingLogicURL: `${origin}/ads/bidding.js`,
        ads: [],
      },
      GROUP_DAYS * 86_400,
    );
    return true;
  } catch {
    return false;
  }
}

/** On withdrawal: nothing stays in the browser. */
export async function leaveAllGroups(origin: string, nav: Navigator = navigator): Promise<void> {
  if (nav.clearOriginJoinedAdInterestGroups) await nav.clearOriginJoinedAdInterestGroups(origin).catch(() => undefined);
}
