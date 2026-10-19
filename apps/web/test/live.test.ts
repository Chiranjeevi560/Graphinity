import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Auth } from '../src/lib/auth.ts';
import { announce, onLive, parseEvents, startLive, type LiveEvent } from '../src/lib/live.ts';

describe('reading live events', () => {
  it('reads whole messages and keeps a half-received one for later', () => {
    const got: LiveEvent[] = [];
    const rest = parseEvents(
      ': connected\n\nevent: answered\ndata: {"questionId":"42"}\n\nevent: sent\ndata: {"questionId":"9"}\n\nevent: routed\ndata: {"questi',
      e => got.push(e),
    );
    expect(got).toEqual([
      { type: 'answered', questionId: '42' },
      { type: 'sent', questionId: '9' },
    ]);
    expect(parseEvents(`${rest}onId":"7"}\n\n`, e => got.push(e))).toBe('');
    expect(got).toEqual([
      { type: 'answered', questionId: '42' },
      { type: 'sent', questionId: '9' },
      { type: 'routed', questionId: '7' },
    ]);
  });

  it('ignores unknown events, pings, broken data and ids that aren’t ids', () => {
    const got: LiveEvent[] = [];
    parseEvents(
      ': ping\n\nevent: other\ndata: {"questionId":"1"}\n\nevent: answered\ndata: not json\n\nevent: answered\ndata: {"questionId":"../me"}\n\n',
      e => got.push(e),
    );
    expect(got).toEqual([]);
  });
});

describe('staying connected', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function fakeAuth(tokens: Array<string | null>, signedIn = true): Auth {
    return {
      getAccessToken: () => Promise.resolve(tokens.length > 1 ? (tokens.shift() ?? null) : (tokens[0] ?? null)),
      hasSession: () => signedIn,
    } as unknown as Auth;
  }
  const stream = (text: string) =>
    new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(text));
        },
      }),
    );

  it('keeps trying after a moment with no token (offline), instead of giving up for the session', async () => {
    vi.useFakeTimers();
    const got: LiveEvent[] = [];
    const fetch = vi.fn(() => Promise.resolve(stream('event: answered\ndata: {"questionId":"5"}\n\n')));
    const stop = startLive({
      origin: 'https://api.test',
      auth: fakeAuth([null, 'access-1']),
      fetch,
      onEvent: e => got.push(e),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(got).toEqual([{ type: 'answered', questionId: '5' }]);
    stop();
  });

  it('stops once signed out', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn();
    startLive({ origin: 'https://api.test', auth: fakeAuth([null], false), fetch, onEvent: () => {} });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('passing events to screens', () => {
  it('reaches every screen listening, and none that stopped', () => {
    vi.stubGlobal('window', new EventTarget());
    vi.stubGlobal('CustomEvent', CustomEvent);
    const a: LiveEvent[] = [],
      b: LiveEvent[] = [];
    const stopA = onLive(e => a.push(e));
    const stopB = onLive(e => b.push(e));
    announce({ type: 'routed', questionId: '3' });
    stopB();
    announce({ type: 'answered', questionId: '4' });
    stopA();
    announce({ type: 'answered', questionId: '5' });
    expect(a).toEqual([
      { type: 'routed', questionId: '3' },
      { type: 'answered', questionId: '4' },
    ]);
    expect(b).toEqual([{ type: 'routed', questionId: '3' }]);
    vi.unstubAllGlobals();
  });
});
