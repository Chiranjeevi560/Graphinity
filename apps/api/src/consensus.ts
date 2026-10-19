// Agreement among answers, as docs/SPEC.md §11.4 defines it:
// read the amount each answer reports, group amounts within 8% of each
// other, weigh each group by its authors' standing (not headcount, which a
// brigade can fake), measure agreement by entropy, and keep the strongest
// answer from every smaller group visible, so an edge case (why one person
// paid ₹1,40,000) is never buried. Pure: no database, no AI.

export type Currency = 'INR' | 'USD' | 'EUR' | 'GBP' | 'AED' | 'JPY';
export interface Amount { minor: number; currency: Currency }

const SYMBOL: Record<string, Currency> = { '₹': 'INR', $: 'USD', '€': 'EUR', '£': 'GBP', '¥': 'JPY' };
const WORD: Record<string, Currency> = { rs: 'INR', 'rs.': 'INR', inr: 'INR', rupees: 'INR', usd: 'USD', dollars: 'USD', eur: 'EUR', euros: 'EUR', gbp: 'GBP', pounds: 'GBP', aed: 'AED', dirhams: 'AED', jpy: 'JPY', yen: 'JPY' };
const SCALE: Record<string, number> = { k: 1e3, thousand: 1e3, lakh: 1e5, lakhs: 1e5, lac: 1e5, l: 1e5, crore: 1e7, crores: 1e7, cr: 1e7, m: 1e6, million: 1e6 };
/** Words that mark the amount the answer is about, not a price mentioned on the way. */
const PAID = /\b(?:paid|pay|paying|duty|duties|charged|charge|cost|costs|total|fee|fees|spent|came to|tax|customs)\b/gi;
/** How far (in characters) such a word may be from its amount. */
const NEAR = 40;

// A figure (Indian or Western grouping), an optional scale word, with a
// currency before it (symbol or word) or after it (word).
const AMOUNT = new RegExp(
  String.raw`(?:(?<pre>[₹$€£¥])\s?|\b(?<preword>rs\.?|inr|usd|eur|gbp|aed|jpy)\s?)?` +
  String.raw`(?<num>\d{1,3}(?:,\d{2,3})+(?:\.\d+)?|\d+(?:\.\d+)?)` +
  String.raw`\s?(?<scale>k|thousand|lakhs?|lac|l|crores?|cr|m|million)?\b` +
  String.raw`(?:\s?(?<post>rs\.?|inr|rupees|usd|dollars|eur|euros|gbp|pounds|aed|dirhams|jpy|yen)\b)?`,
  'giu');

/** Every amount with a currency in the text, with where it was found. */
export function amountsIn(text: string): Array<Amount & { at: number }> {
  const found: Array<Amount & { at: number }> = [];
  for (const m of text.normalize('NFC').matchAll(AMOUNT)) {
    const g = m.groups ?? {};
    const currency = (g.pre && SYMBOL[g.pre]) ?? (g.preword && WORD[g.preword.toLowerCase()]) ?? (g.post && WORD[g.post.toLowerCase()]);
    if (!currency || !g.num) continue;
    const value = Number(g.num.replace(/,/g, '')) * (g.scale ? SCALE[g.scale.toLowerCase()] ?? 1 : 1);
    if (!Number.isFinite(value) || value <= 0) continue;
    // Integer minor units (paise, cents), as spec §22.3 #4 asks: no float drift.
    found.push({ minor: Math.round(value * 100), currency, at: m.index });
  }
  return found;
}

/**
 * The amount an answer reports: the one closest to a word like "paid" or
 * "duty" ("the duty came to ₹95,000 on a ₹3,00,000 watch" is ₹95,000);
 * otherwise the last one mentioned (people tend to end on the total).
 */
export function reportedAmount(text: string): Amount | null {
  const clean = text.normalize('NFC');
  const all = amountsIn(clean);
  const cues = [...clean.matchAll(PAID)].map(m => m.index);
  const distance = (at: number) => Math.min(Infinity, ...cues.map(c => Math.abs(c - at)));
  const near = all.filter(a => distance(a.at) <= NEAR).sort((a, b) => distance(a.at) - distance(b.at) || b.at - a.at);
  const pick = near[0] ?? all[all.length - 1];
  return pick ? { minor: pick.minor, currency: pick.currency } : null;
}

export interface Claim {
  answerId: string;
  amount: Amount;
  /** Author's reputation in the field, 0 to 1. */
  reputation: number;
  /** Author's trust, 0 to 1. */
  trust: number;
}

export interface Cluster {
  answerIds: string[];
  currency: Currency;
  lowMinor: number;
  highMinor: number;
  /** Trust-weighted share of all claims, 0 to 1. */
  mass: number;
}

export interface Consensus {
  clusters: Cluster[];
  /** 1 − normalised entropy: 1 when everyone agrees, near 0 when evenly split. */
  confidence: number;
  /** The strongest answer from every group but the largest: shown, pinned, never buried. */
  minorityPinned: string[];
}

/** Spec §11.4: amounts within 8% of their neighbour belong together. */
export const EPSILON_REL = 0.08;

/** Spec §11.4: a claim weighs (0.5 + 0.5·reputation) × trust. */
export function claimWeight(c: Pick<Claim, 'reputation' | 'trust'>): number {
  return (0.5 + 0.5 * clamp01(c.reputation)) * clamp01(c.trust);
}

export function consensus(claims: readonly Claim[]): Consensus {
  // Amounts in different currencies can't agree or disagree: group within each.
  const groups: Cluster[] = [];
  const weightOf = new Map(claims.map(c => [c.answerId, claimWeight(c)]));
  const byCurrency = new Map<Currency, Claim[]>();
  for (const c of claims) byCurrency.set(c.amount.currency, [...(byCurrency.get(c.amount.currency) ?? []), c]);
  for (const [currency, list] of byCurrency) {
    // One-dimensional DBSCAN with one point per core: sorted, a new group
    // starts wherever the gap to the previous amount is more than 8%.
    const sorted = [...list].sort((a, b) => a.amount.minor - b.amount.minor);
    let current: Claim[] = [];
    const close = () => {
      const first = current[0], last = current[current.length - 1];
      if (first && last) groups.push({ answerIds: current.map(c => c.answerId), currency, lowMinor: first.amount.minor, highMinor: last.amount.minor, mass: 0 });
      current = [];
    };
    for (const c of sorted) {
      const prev = current[current.length - 1];
      if (prev && (c.amount.minor - prev.amount.minor) / c.amount.minor > EPSILON_REL) close();
      current.push(c);
    }
    close();
  }
  const total = claims.reduce((sum, c) => sum + (weightOf.get(c.answerId) ?? 0), 0);
  for (const g of groups) {
    const weight = g.answerIds.reduce((sum, id) => sum + (weightOf.get(id) ?? 0), 0);
    // With no trust at all to go on, every claim counts the same.
    g.mass = total > 0 ? weight / total : g.answerIds.length / Math.max(1, claims.length);
  }
  groups.sort((a, b) => b.mass - a.mass || b.answerIds.length - a.answerIds.length || a.lowMinor - b.lowMinor);

  // Spec §11.4: H = −Σ M ln M / ln(max(groups, 2)); confidence = 1 − H.
  const entropy = -groups.reduce((sum, g) => sum + (g.mass > 0 ? g.mass * Math.log(g.mass) : 0), 0) / Math.log(Math.max(groups.length, 2));
  const confidence = groups.length === 0 ? 0 : clamp01(1 - entropy);

  const minorityPinned = groups.slice(1).flatMap(g => {
    const strongest = [...g.answerIds].sort((a, b) => (weightOf.get(b) ?? 0) - (weightOf.get(a) ?? 0))[0];
    return strongest ? [strongest] : [];
  });
  return { clusters: groups, confidence, minorityPinned };
}

function clamp01(x: number): number {
  return Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0;
}
