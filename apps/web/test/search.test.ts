import { describe, expect, it } from 'vitest';
import { createApi } from '../src/lib/api.ts';
import type { Auth } from '../src/lib/auth.ts';
import {
  clearPendingSearch,
  correctionWords,
  finishReading,
  forgetSearch,
  lastSearch,
  openedFromSearch,
  pendingSearch,
  readingVisible,
  reasonWords,
  rememberSearch,
  searchFor,
} from '../src/lib/search.ts';

const SEARCH = '0b3c7c1a-2f6e-4d0a-9a51-3c2b1d4e5f60';

function recorder() {
  const sent: Array<{ path: string; body: { dwellMs?: number }; keepalive: boolean }> = [];
  const send = (path: string, body: { dwellMs?: number }, keepalive: boolean) => {
    sent.push({ path, body, keepalive });
    return Promise.resolve();
  };
  return { sent, send };
}

describe('search words', () => {
  it('says why each result is there', () => {
    expect(reasonWords(['every_word', 'meaning'])).toBe('Has all your words · Similar in meaning');
    expect(reasonWords(['some_words'])).toBe('Has some of your words');
  });

  it('names what else was searched for, once each', () => {
    expect(correctionWords([])).toBeNull();
    expect(correctionWords([{ to: 'customs' }])).toBe('Also searched for “customs”.');
    expect(correctionWords([{ to: 'customs' }, { to: 'camera' }, { to: 'customs' }])).toBe(
      'Also searched for “customs” and “camera”.',
    );
    expect(correctionWords([{ to: 'a' }, { to: 'b' }, { to: 'c' }])).toBe('Also searched for “a”, “b” and “c”.');
  });
});

describe('the last search', () => {
  it('is kept for going back, handed over from the home page once, and forgotten on sign-out', () => {
    const response = { results: [], corrections: [], meaning: true };
    rememberSearch('visa', response);
    expect(lastSearch()).toEqual({ query: 'visa', response });
    searchFor('customs');
    // Read without being used up (React may read it twice), cleared once it runs.
    expect(pendingSearch()).toBe('customs');
    expect(pendingSearch()).toBe('customs');
    clearPendingSearch();
    expect(pendingSearch()).toBeNull();
    searchFor('again');
    forgetSearch();
    expect(lastSearch()).toBeNull();
    expect(pendingSearch()).toBeNull();
  });
});

describe('reading time', () => {
  it('records the open, then counts only time in view, sent once on leaving', () => {
    const { sent, send } = recorder();
    openedFromSearch(send, { searchId: SEARCH, position: 3, questionId: '42' }, 1_000);
    expect(sent).toEqual([{ path: `/searches/${SEARCH}/opens/3`, body: {}, keepalive: false }]);
    readingVisible(false, 6_000); // 5 s read, then another tab
    readingVisible(false, 9_000); // still hidden: nothing changes
    readingVisible(true, 60_000); // back after a long while: not counted
    finishReading(send, '42', 62_000); // 2 s more
    expect(sent[1]).toEqual({ path: `/searches/${SEARCH}/opens/3`, body: { dwellMs: 7_000 }, keepalive: true });
    // Once only, and only for the question that was opened.
    finishReading(send, '42', 70_000);
    expect(sent).toHaveLength(2);
  });

  it('ignores another question, caps at an hour, and never lets a failure surface', () => {
    const failing = () => Promise.reject(new Error('offline'));
    openedFromSearch(failing, { searchId: SEARCH, position: 1, questionId: '7' }, 0);
    const { sent, send } = recorder();
    finishReading(send, '8', 10);
    expect(sent).toEqual([]);
    finishReading(send, '7', 5 * 3_600_000);
    expect(sent).toEqual([{ path: `/searches/${SEARCH}/opens/1`, body: { dwellMs: 3_600_000 }, keepalive: true }]);
  });

  it('sends a reading time with keepalive, so it arrives as the page closes', async () => {
    const seen: RequestInit[] = [];
    const api = createApi({
      origin: 'https://api.test',
      auth: { getAccessToken: () => Promise.resolve('t'), hasSession: () => true, clear: () => {} } as unknown as Auth,
      fetch: ((_url: string, init: RequestInit) => {
        seen.push(init);
        return Promise.resolve(new Response(null, { status: 204 }));
      }) as unknown as typeof fetch,
      online: () => true,
    });
    await api('/searches/x/opens/1', { method: 'PUT', signedIn: true, body: { dwellMs: 1 }, keepalive: true });
    await api('/searches/x/opens/1', { method: 'PUT', signedIn: true, body: {} });
    expect(seen[0]?.keepalive).toBe(true);
    expect(seen[1]?.keepalive).toBeUndefined();
  });
});
