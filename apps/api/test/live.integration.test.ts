// Live updates over a real socket: who hears what, and when a stream ends.
import { beforeAll, describe, expect, it } from 'vitest';
import { startApp, type TestApp } from './helpers/app.ts';
import { must } from './helpers/must.ts';

let h: TestApp;
let base = '';
let names = 0;
const SITE = 'https://graphinity.pages.dev';

beforeAll(async () => {
  h = await startApp(() => Date.now());
  base = await h.app.listen({ port: 0, host: '127.0.0.1' });
  return async () => {
    // Node's fetch opens spare sockets that never send a request; the server
    // would wait out its 15 s request timeout for them. Not ours to keep.
    h.app.server.closeAllConnections();
    await h.close();
  };
});

async function member() {
  const p = await h.person();
  names += 1;
  const res = await h.call('POST', '/me/profile', p.token, {
    handle: `live.${String(names)}`,
    country: 'IN',
    fields: ['travel'],
    adult: true,
  });
  expect(res.statusCode).toBe(201);
  return p;
}

/** Opens a stream and collects what arrives, until stopped or the server ends it. */
function listen(token: string) {
  const controller = new AbortController();
  const received: string[] = [];
  let ended = false;
  const ready = fetch(`${base}/events`, {
    headers: { authorization: `Bearer ${token}`, origin: SITE },
    signal: controller.signal,
  }).then(res => {
    const reader = must(res.body).getReader();
    const decoder = new TextDecoder();
    void (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          received.push(decoder.decode(value));
        }
      } catch {
        /* aborted by the test */
      }
      ended = true;
    })();
    return res;
  });
  return {
    ready,
    received,
    stop: () => {
      controller.abort();
    },
    get ended() {
      return ended;
    },
  };
}

const until = async (check: () => boolean, ms = 3000) => {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting');
    await new Promise(r => setTimeout(r, 20));
  }
};

describe('live updates', () => {
  it('tell the asker about a new answer, and nobody else', async () => {
    const asker = await member(),
      answerer = await member(),
      bystander = await member();
    const mine = listen(asker.token),
      theirs = listen(bystander.token);
    const res = await mine.ready;
    await theirs.ready;
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(res.headers.get('access-control-allow-origin')).toBe(SITE);
    const q = must(
      (
        await h.call('POST', '/questions', asker.token, {
          title: 'Best way to get from the airport to the city late at night?',
          field: 'travel',
        })
      ).json<{ question: { id: string } }>().question.id,
    );
    await h.call('POST', `/questions/${q}/answers`, answerer.token, {
      body: 'The night bus runs every 30 minutes until 2am.',
    });
    await until(() => mine.received.join('').includes('event: answered'));
    expect(mine.received.join('')).toContain(`event: answered\ndata: {"questionId":"${q}"}\n\n`);
    expect(theirs.received.join('')).not.toContain('event:');
    mine.stop();
    theirs.stop();
  });

  it('need sign-in, and allow a few windows per person', async () => {
    const unsigned = await fetch(`${base}/events`);
    await unsigned.text();
    expect(unsigned.status).toBe(401);
    const p = await member();
    const streams = [listen(p.token), listen(p.token), listen(p.token)];
    await Promise.all(streams.map(s => s.ready));
    const fourth = await fetch(`${base}/events`, { headers: { authorization: `Bearer ${p.token}` } });
    await fourth.text();
    expect(fourth.status).toBe(429);
    for (const s of streams) s.stop();
    // Closed windows free their places.
    await until(() => streams.every(s => s.ended));
    const again = listen(p.token);
    expect((await again.ready).status).toBe(200);
    again.stop();
  });

  it('end on their own a minute before the sign-in expires', async () => {
    const p = await member();
    const shortLived = await h.issuer.sign({}, { sub: p.id, lifetime: 61 });
    const s = listen(shortLived);
    expect((await s.ready).status).toBe(200);
    await until(() => s.ended, 4000);
    const tooShort = await h.issuer.sign({}, { sub: p.id, lifetime: 30 });
    const refused = await fetch(`${base}/events`, { headers: { authorization: `Bearer ${tooShort}` } });
    await refused.text();
    expect(refused.status).toBe(401);
  });
});

describe('clients that leave while being let in', () => {
  it('don’t use up anyone’s places', async () => {
    const p = await member();
    // Abandon streams at once, again and again, while sign-in is being checked.
    for (let i = 0; i < 12; i++) {
      const controller = new AbortController();
      const started = fetch(`${base}/events`, {
        headers: { authorization: `Bearer ${p.token}` },
        signal: controller.signal,
      }).catch(() => null);
      await new Promise(r => setTimeout(r, i % 3));
      controller.abort();
      await started;
    }
    await new Promise(r => setTimeout(r, 200));
    // All three of this person's places are still free.
    const streams = [listen(p.token), listen(p.token), listen(p.token)];
    expect((await Promise.all(streams.map(s => s.ready))).map(r => r.status)).toEqual([200, 200, 200]);
    for (const s of streams) s.stop();
  });
});

describe('shutting down', () => {
  it('ends open streams itself, so a redeploy isn’t held up', async () => {
    const other = await startApp(() => Date.now());
    try {
      const address = await other.app.listen({ port: 0, host: '127.0.0.1' });
      const p = await other.person();
      await other.call('POST', '/me/profile', p.token, {
        handle: 'live.shutdown',
        country: 'IN',
        fields: ['travel'],
        adult: true,
      });
      const { request } = await import('node:http');
      // node:http with no agent: exactly one socket, kept open by the stream.
      const ended = new Promise<void>((resolve, reject) => {
        const req = request(
          `${address}/events`,
          { agent: false, headers: { authorization: `Bearer ${p.token}` } },
          res => {
            res.on('data', () => {
              /* pings */
            });
            res.on('end', resolve);
          },
        );
        req.on('error', reject);
        req.end();
      });
      await new Promise(r => setTimeout(r, 100));
      const started = Date.now();
      await other.app.close();
      await ended;
      expect(Date.now() - started).toBeLessThan(2000);
    } finally {
      await other.t.close();
    }
  });
});
