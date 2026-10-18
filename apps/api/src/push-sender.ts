// Sends a web push to every device of one person when something happens
// for them. Runs in the background as the server (asSystem); a failure is
// logged by kind and status only, never with the address.
import type { Database } from './db.ts';
import type { PersonEvent } from './events.ts';
import { encryptPush, isPushService, vapidHeader, type VapidKeys } from './push.ts';
import { errorKind } from './jobs.ts';

interface Log { warn(obj: object, msg: string): void }

const titles = { routed: 'A question for you', answered: 'New answer to your question' } as const;

export function createPushSender(deps: { db: Database; vapid: VapidKeys; fetch: typeof fetch; log: Log; now: () => number }) {
  return async (userId: string, event: PersonEvent): Promise<void> => {
    // Shown on the asker's open page only: a phone buzz for each wave would be noise.
    if (event.type === 'sent') return;
    const { subscriptions, question } = await deps.db.asSystem(async q => ({
      subscriptions: (await q.query<{ endpoint: string; p256dh: string; auth: string }>(
        'SELECT endpoint, p256dh, auth FROM app.push_subscriptions WHERE profile_id = $1', [userId])).rows,
      question: (await q.query<{ title: string }>('SELECT title FROM app.questions WHERE id = $1', [event.questionId])).rows[0],
    }));
    if (!question) return;
    // Encrypted for the device; the push service can't read it.
    const payload = Buffer.from(JSON.stringify({ title: titles[event.type], body: question.title, questionId: event.questionId }));
    for (const sub of subscriptions) {
      if (!isPushService(sub.endpoint)) continue;
      let status = 0;
      try {
        const res = await deps.fetch(sub.endpoint, {
          method: 'POST',
          headers: {
            authorization: await vapidHeader(sub.endpoint, deps.vapid, Math.floor(deps.now() / 1000)),
            'content-encoding': 'aes128gcm',
            'content-type': 'application/octet-stream',
            // Keep trying for a day if the device is off; then it's stale news.
            ttl: '86400',
            urgency: 'normal',
          },
          body: new Uint8Array(encryptPush(payload, Buffer.from(sub.p256dh, 'base64url'), Buffer.from(sub.auth, 'base64url'))),
          signal: AbortSignal.timeout(10_000),
        });
        status = res.status;
      } catch (err) {
        deps.log.warn({ kind: errorKind(err) }, 'push failed');
        continue;
      }
      // 404/410: the browser unsubscribed or the subscription expired.
      if (status === 404 || status === 410) {
        await deps.db.asSystem(q => q.query('DELETE FROM app.push_subscriptions WHERE endpoint = $1', [sub.endpoint]));
      } else if (status < 200 || status >= 300) {
        deps.log.warn({ status }, 'push refused');
      }
    }
  };
}

/** Runs at most `max` of the given tasks at once; the rest wait their turn. */
export function createLimiter(max: number) {
  let running = 0;
  const waiting: Array<() => void> = [];
  return async function run<T>(task: () => Promise<T>): Promise<T> {
    if (running >= max) await new Promise<void>(resolve => { waiting.push(resolve); });
    running += 1;
    try {
      return await task();
    } finally {
      running -= 1;
      waiting.shift()?.();
    }
  };
}

