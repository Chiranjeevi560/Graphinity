// Questions as the API sends them, and the small helpers screens share.

export interface QuestionSummary {
  id: string;
  title: string;
  field: { slug: string; name: string };
  country: { code: string; name: string } | null;
  asker: { handle: string };
  createdAt: string;
  answerCount: number;
}

export type Medal = 'verified' | 'bronze' | 'silver' | 'gold';
export interface Amount {
  minor: number;
  currency: string;
}

export interface Answer {
  id: string;
  body: string;
  answerer: { handle: string };
  createdAt: string;
  helpful: boolean;
  /** The author's standing in this question's field (spec §11.3). */
  author: { reputation: number; accepted: number; medal: Medal | null };
  /** The amount the answer reports, if any (spec §11.4). */
  claim: Amount | null;
  /** The strongest answer of a smaller group: kept visible, never buried. */
  minorityPinned: boolean;
}

/** The asker's pick. `answerId` is null if the picked answer's author left. */
export interface Selection {
  answerId: string | null;
  changesLeft: number;
  correct: boolean | null;
  /** The asker's 1-5 star rating of the pick; null until given. */
  stars: number | null;
}

/** How far the answers' amounts agree, once 3 report one. Shares are trust-weighted. */
export interface Consensus {
  confidence: number;
  clusters: Array<{ currency: string; lowMinor: number; highMinor: number; share: number; answers: number }>;
}

export const MEDAL_NAMES: Record<Medal, string> = {
  verified: 'Verified',
  bronze: 'Bronze',
  silver: 'Silver',
  gold: 'Gold',
};

/** "₹1,40,000", "$1,200.50": the currency's own way of writing amounts, whole units when whole. */
export function formatAmount(minor: number, currency: string): string {
  const value = minor / 100;
  try {
    return new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : 'en', {
      style: 'currency',
      currency,
      currencyDisplay: 'narrowSymbol',
      maximumFractionDigits: Number.isInteger(value) ? 0 : 2,
    }).format(value);
  } catch {
    return `${currency} ${value.toLocaleString('en')}`;
  }
}

/** A range when the group spans one, a single amount when it doesn't. */
export function formatRange(lowMinor: number, highMinor: number, currency: string): string {
  return lowMinor === highMinor
    ? formatAmount(lowMinor, currency)
    : `${formatAmount(lowMinor, currency)}–${formatAmount(highMinor, currency)}`;
}

/** Spec §11.4 confidence in words: ≥ 0.7 is where it stops sending more people. */
export function agreementWords(confidence: number): string {
  if (confidence >= 0.7) return 'Most people agree';
  if (confidence >= 0.4) return 'People partly agree';
  return 'People’s experiences differ';
}

export const CHANGE_REASONS = [
  { value: 'turned_out_wrong', label: 'It turned out wrong' },
  { value: 'better_answer_later', label: 'A better answer came later' },
  { value: 'picked_by_mistake', label: 'I picked it by mistake' },
] as const;
export type ChangeReason = (typeof CHANGE_REASONS)[number]['value'];

export const TITLE = { min: 15, max: 150 };
export const DETAILS_MAX = 5000;
export const ANSWER = { min: 20, max: 10_000 };

/** "How do I import a watch?" → "how-do-i-import-a-watch". Readable addresses; only the id matters. */
export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug.length <= 80) return slug;
  const cut = slug.slice(0, 80);
  return cut.slice(0, Math.max(cut.lastIndexOf('-'), 40)).replace(/-+$/, '');
}

export function questionPath(q: { id: string; title: string }): string {
  const slug = slugify(q.title);
  return slug ? `/q/${q.id}/${slug}` : `/q/${q.id}`;
}

/** Characters as people count them, like the server does. */
export function charCount(text: string): number {
  let n = 0;
  for (const _ch of text) n++;
  return n;
}

const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
const dateFormat = new Intl.DateTimeFormat('en', { day: 'numeric', month: 'short', year: 'numeric' });

/** "just now", "5 minutes ago", "yesterday", then a date after a month. */
export function timeAgo(iso: string, now: number): string {
  const seconds = Math.round((now - Date.parse(iso)) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return relative.format(-minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (hours < 24) return relative.format(-hours, 'hour');
  const days = Math.round(hours / 24);
  if (days < 30) return relative.format(-days, 'day');
  return dateFormat.format(new Date(iso));
}

const answersWord = (n: number) => (n === 1 ? '1 answer' : `${String(n)} answers`);

/**
 * The agreement bar in one sentence, for readers who don't see the bar: search
 * snippets, AI assistants citing the page, and the page before its script
 * runs. "Most people agree: ₹95,000–₹96,000 (67%, 2 answers). Also reported:
 * ₹1,40,000 (33%, 1 answer). From 3 answers that give an amount, weighed by
 * each person's record in this field." The same words as the bar's.
 */
export function consensusSentence(consensus: Consensus): string {
  const part = (c: Consensus['clusters'][number]) =>
    `${formatRange(c.lowMinor, c.highMinor, c.currency)} (${String(Math.round(c.share * 100))}%, ${answersWord(c.answers)})`;
  const [first, ...rest] = consensus.clusters;
  if (!first) return '';
  const total = consensus.clusters.reduce((n, c) => n + c.answers, 0);
  return [
    `${agreementWords(consensus.confidence)}: ${part(first)}.`,
    rest.length ? `Also reported: ${rest.map(part).join('; ')}.` : '',
    `From ${answersWord(total)} that give an amount, weighed by each person’s record in this field.`,
  ]
    .filter(Boolean)
    .join(' ');
}
