// Live updates while the site is open: one stream per signed-in tab, as
// server-sent events. Each message names only what happened and which
// question; the screen fetches the rest the normal way.
import type { FastifyInstance } from 'fastify';
import type { Clock } from '../rate-limit.ts';
import type { Events, PersonEvent } from '../events.ts';
import { fail, signedIn } from './common.ts';

export const LIVE_LIMITS = {
  perPerson: 3,
  total: 300,
  /** The server drops a connection silent for 15 s; a comment line keeps it open. */
  pingMs: 10_000,
  /** Close before the token expires, so a deleted or signed-out account stops hearing. */
  closeBeforeExpiryMs: 60_000,
};

export function registerLiveRoutes(app: FastifyInstance, { events, clock }: { events: Events; clock: Clock }) {
  const open = new Map<string, number>();
  let total = 0;
  // Shutting down ends every stream first: closing waits for open requests,
  // and a stream never finishes by itself ('onClose' would wait forever).
  const streams = new Set<() => void>();
  app.addHook('preClose', done => {
    for (const end of streams) end();
    done();
  });

  app.get('/events', { config: { auth: 'required' } }, (req, reply) => {
    const user = signedIn(req);
    const mine = open.get(user.id) ?? 0;
    // ponytail: counts per instance; a shared count if there is ever more than one.
    if (mine >= LIVE_LIMITS.perPerson || total >= LIVE_LIMITS.total) {
      return fail(reply, 429, 'rate_limited', 'Too many open windows. Close one and try again.');
    }
    const lifetime = user.expiresAt * 1000 - clock.now() - LIVE_LIMITS.closeBeforeExpiryMs;
    if (lifetime <= 0) return fail(reply, 401, 'signed_out', 'You’re signed out. Sign in again to continue.');
    // The client may have gone while sign-in was being checked: its "close"
    // already fired, so nothing set up below would ever be cleaned up.
    if (req.raw.destroyed || reply.raw.destroyed || req.raw.socket.destroyed) return reply.code(499).send();

    open.set(user.id, mine + 1);
    total += 1;
    // The CORS plugin already set its headers on the reply; keep them on the raw stream.
    reply.hijack();
    const set = Object.entries(reply.getHeaders()).filter(
      (h): h is [string, string | number | string[]] => h[1] !== undefined,
    );
    reply.raw.writeHead(200, {
      ...Object.fromEntries(set),
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      // Proxies must pass each message on at once, not hold them back.
      'x-accel-buffering': 'no',
    });
    reply.raw.write(': connected\n\n');

    const send = (event: PersonEvent) => {
      reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify({ questionId: event.questionId })}\n\n`);
    };
    const stop = events.subscribe(user.id, send);
    const ping = setInterval(() => {
      reply.raw.write(': ping\n\n');
    }, LIVE_LIMITS.pingMs);
    const expire = setTimeout(() => {
      reply.raw.end();
    }, lifetime);
    let closed = false;
    const startedAt = clock.now();
    const end = () => {
      reply.raw.end();
    };
    streams.add(end);
    const cleanUp = () => {
      if (closed) return;
      closed = true;
      streams.delete(end);
      stop();
      clearInterval(ping);
      clearTimeout(expire);
      const left = (open.get(user.id) ?? 1) - 1;
      if (left > 0) open.set(user.id, left);
      else open.delete(user.id);
      total -= 1;
      // Hijacked replies skip the usual request log; same fields, logged at the end.
      req.log.info({ method: 'GET', route: '/events', status: 200, ms: clock.now() - startedAt }, 'request');
    };
    reply.raw.on('close', cleanUp);
  });
}
