// Sends a web push to every device of one person when something happens
// for them. Runs in the background as the server (asSystem); a failure is
// logged by kind and status only, never with the address.
import type { Database } from './db.ts';
import type { PersonEvent } from './events.ts';
import { encryptPush, isPushService, vapidHeader, type VapidKeys } from './push.ts';
import { errorKind } from './jobs.ts';

interface Log {
  warn(obj: object, msg: string): void;
}

const titles = { routed: 'A question for you', answered: 'New answer to your question' } as const;

interface PushDeps {
  db: Database;
  vapid: VapidKeys;
  fetch: typeof fetch;
  log: Log;
  now: () => number;
}

/** Encrypts `payload` for each of the person's devices and sends it; drops devices that are gone. */
async function deliver(deps: PushDeps, userId: string, payload: object, urgency: 'normal' | 'high'): Promise<void> {
  const subscriptions = (
    await deps.db.asSystem(q =>
      q.query<{ endpoint: string; p256dh: string; auth: string }>(
        'SELECT endpoint, p256dh, auth FROM app.push_subscriptions WHERE profile_id = $1',
        [userId],
      ),
    )
  ).rows;
  // Encrypted for the device; the push service can't read it.
  const body = Buffer.from(JSON.stringify(payload));
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
          urgency,
        },
        body: new Uint8Array(
          encryptPush(body, Buffer.from(sub.p256dh, 'base64url'), Buffer.from(sub.auth, 'base64url')),
        ),
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
}

export function createPushSender(deps: PushDeps) {
  return async (userId: string, event: PersonEvent): Promise<void> => {
    // Shown on the asker's open page only: a phone buzz for each wave would be noise.
    if (event.type === 'sent') return;
    const question = (
      await deps.db.asSystem(q =>
        q.query<{ title: string }>('SELECT title FROM app.questions WHERE id = $1', [event.questionId]),
      )
    ).rows[0];
    if (!question) return;
    await deliver(
      deps,
      userId,
      { title: titles[event.type], body: question.title, questionId: event.questionId },
      'normal',
    );
  };
}

/**
 * Tells a moderator about a problem with Graphinity itself (ADR 0020): the
 * notification opens the operations screen. High urgency, so a phone saving
 * battery still shows it.
 */
export function createAlertSender(deps: PushDeps) {
  return (userId: string, problem: { key: string; title: string; body: string }): Promise<void> =>
    deliver(deps, userId, { kind: 'ops', key: problem.key, title: problem.title, body: problem.body }, 'high');
}

/** Runs at most `max` of the given tasks at once; the rest wait their turn. */
export function createLimiter(max: number) {
  let running = 0;
  const waiting: Array<() => void> = [];
  return async function run<T>(task: () => Promise<T>): Promise<T> {
    if (running >= max)
      await new Promise<void>(resolve => {
        waiting.push(resolve);
      });
    running += 1;
    try {
      return await task();
    } finally {
      running -= 1;
      waiting.shift()?.();
    }
  };
}
