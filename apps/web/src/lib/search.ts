// Searching questions (ADR 0015 part 4). The query goes in a request body,
// never in the address, so it stays out of browser history and links. The
// last results are kept in memory for this tab, so going back from a question
// finds them again, and are gone on reload.

export type Reason = 'every_word' | 'some_words' | 'meaning';

export interface SearchResult {
  id: string;
  title: string;
  field: { slug: string; name: string };
  answerCount: number;
  lastAnsweredAt: string | null;
  reasons: Reason[];
}

export interface SearchResponse {
  results: SearchResult[];
  corrections: Array<{ from: string; to: string }>;
  /** False while matching by meaning is unavailable: words only. */
  meaning: boolean;
  /** Only when the person has "improve search for everyone" on. */
  searchId?: string;
}

export const QUERY_MIN = 2;
export const QUERY_MAX = 200;

/** Why a result is there, in words. */
export function reasonWords(reasons: readonly Reason[]): string {
  const words: Record<Reason, string> = {
    every_word: 'Has all your words',
    some_words: 'Has some of your words',
    meaning: 'Similar in meaning',
  };
  return reasons.map(r => words[r]).join(' · ');
}

/** "Also searched for “customs” and “camera”." */
export function correctionWords(corrections: ReadonlyArray<{ to: string }>): string | null {
  const words = [...new Set(corrections.map(c => `“${c.to}”`))];
  if (words.length === 0) return null;
  const list = words.length === 1 ? words[0] : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1] ?? ''}`;
  return `Also searched for ${list ?? ''}.`;
}

let last: { query: string; response: SearchResponse } | null = null;
let pendingQuery: string | null = null;

/** The home page's field hands its query over in memory, never in the address. */
export function searchFor(query: string): void {
  pendingQuery = query;
}

/** The query handed over from the home page, until the Search screen runs it. */
export function pendingSearch(): string | null {
  return pendingQuery;
}

export function clearPendingSearch(): void {
  pendingQuery = null;
}

/** The last search in this tab, to show again after going back to it. */
export function lastSearch(): { query: string; response: SearchResponse } | null {
  return last;
}

export function rememberSearch(query: string, response: SearchResponse): void {
  last = { query, response };
}

/** Forgets the last search: signing out, so the next person on this device doesn't see it. */
export function forgetSearch(): void {
  last = null;
  pendingQuery = null;
  opened = null;
}

type Send = (path: string, body: { dwellMs?: number }, keepalive: boolean) => Promise<unknown>;

/**
 * The question opened from a recorded search, while it is being read: how
 * long is measured only while the page is visible, and sent once, when the
 * person leaves it (another screen, another tab, or closing it).
 */
let opened: { searchId: string; position: number; questionId: string; visibleMs: number; since: number | null } | null =
  null;

export function openedFromSearch(
  send: Send,
  input: { searchId: string; position: number; questionId: string },
  now = Date.now(),
): void {
  opened = { ...input, visibleMs: 0, since: now };
  // Telemetry never gets in the way: a failure is simply not recorded.
  send(`/searches/${input.searchId}/opens/${String(input.position)}`, {}, false).catch(() => undefined);
}

/** The page was hidden or shown again: reading time counts only while it is in view. */
export function readingVisible(visible: boolean, now = Date.now()): void {
  if (!opened) return;
  if (!visible && opened.since !== null) {
    opened.visibleMs += now - opened.since;
    opened.since = null;
  } else if (visible && opened.since === null) {
    opened.since = now;
  }
}

/** Leaving the question: send how long it was read, once. */
export function finishReading(send: Send, questionId: string, now = Date.now()): void {
  if (opened?.questionId !== questionId) return;
  const o = opened;
  opened = null;
  const ms = Math.min(3_600_000, Math.round(o.visibleMs + (o.since === null ? 0 : now - o.since)));
  send(`/searches/${o.searchId}/opens/${String(o.position)}`, { dwellMs: ms }, true).catch(() => undefined);
}
