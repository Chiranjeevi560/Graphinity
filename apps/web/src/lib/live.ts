// Live updates from the server while signed in: one stream, read with
// fetch (EventSource can't send the sign-in header), reconnecting with a
// growing pause when it drops. The server ends each stream before the
// sign-in token expires; the next one starts with a fresh token.
import type { Auth } from './auth.ts';

export interface LiveEvent {
  type: 'routed' | 'answered' | 'sent';
  questionId: string;
}

/** Turns server-sent event text into events; returns what's left unparsed. */
export function parseEvents(buffer: string, emit: (e: LiveEvent) => void): string {
  const blocks = buffer.split('\n\n');
  const rest = blocks.pop() ?? '';
  for (const block of blocks) {
    let type = '';
    let data = '';
    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) type = line.slice(7);
      else if (line.startsWith('data: ')) data += line.slice(6);
    }
    if (type !== 'routed' && type !== 'answered' && type !== 'sent') continue;
    try {
      const { questionId } = JSON.parse(data) as { questionId?: unknown };
      if (typeof questionId === 'string' && /^[1-9][0-9]{0,15}$/.test(questionId)) emit({ type, questionId });
    } catch {
      /* a malformed message is skipped, not fatal */
    }
  }
  return rest;
}

export function startLive(deps: {
  origin: string;
  auth: Auth;
  fetch: typeof fetch;
  onEvent: (e: LiveEvent) => void;
}): () => void {
  // Set by the returned stop function, from outside the loop.
  let stopped = false;
  const isStopped = () => stopped;
  let controller: AbortController | null = null;
  let pause = 1000;

  async function run() {
    while (!isStopped()) {
      const token = await deps.auth.getAccessToken();
      if (isStopped()) return;
      // Signed out: nothing to listen for. Signed in but no token right now
      // (offline, or Supabase briefly down): wait and try again below.
      if (!token && !deps.auth.hasSession()) return;
      if (token) {
        controller = new AbortController();
        try {
          const res = await deps.fetch(`${deps.origin}/events`, {
            headers: { authorization: `Bearer ${token}` },
            signal: controller.signal,
          });
          if (res.ok && res.body) {
            pause = 1000;
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              buffer = parseEvents(buffer + decoder.decode(value, { stream: true }), deps.onEvent);
            }
            // Ended by the server (token about to expire): reconnect at once.
            continue;
          }
          if (res.status === 401) await deps.auth.getAccessToken({ forceRefresh: true });
        } catch {
          if (isStopped()) return;
        }
      }
      // Dropped or refused: wait, a little longer each time, up to a minute.
      await new Promise(r => setTimeout(r, pause + Math.random() * 500));
      pause = Math.min(pause * 2, 60_000);
    }
  }

  void run();
  return () => {
    stopped = true;
    controller?.abort();
  };
}

const LIVE_EVENT = 'graphinity:live';

/** Passes an event to every screen listening (see useLive). */
export function announce(event: LiveEvent): void {
  window.dispatchEvent(new CustomEvent<LiveEvent>(LIVE_EVENT, { detail: event }));
}

/** Calls handler for each live event while the screen is shown. */
export function onLive(handler: (event: LiveEvent) => void): () => void {
  const listener = (e: Event) => {
    handler((e as CustomEvent<LiveEvent>).detail);
  };
  window.addEventListener(LIVE_EVENT, listener);
  return () => {
    window.removeEventListener(LIVE_EVENT, listener);
  };
}
