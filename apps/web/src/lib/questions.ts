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

export interface Answer {
  id: string;
  body: string;
  answerer: { handle: string };
  createdAt: string;
  helpful: boolean;
}

/** The asker's pick. `answerId` is null if the picked answer's author left. */
export interface Selection {
  answerId: string | null;
  changesLeft: number;
  correct: boolean | null;
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
  const slug = title.toLowerCase().normalize('NFKD').replace(/\p{M}+/gu, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
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
