// Turning web push on and off for a device.
import type { FastifyInstance } from 'fastify';
import type { Database } from '../db.ts';
import { isPushService } from '../push.ts';
import { fail, pgCode, signedIn } from './common.ts';

const endpointSchema = { type: 'object', additionalProperties: false, required: ['endpoint'], properties: { endpoint: { type: 'string', maxLength: 1000 } } } as const;

const subscriptionSchema = {
  type: 'object', additionalProperties: false, required: ['endpoint', 'keys'],
  properties: {
    endpoint: { type: 'string', maxLength: 1000 },
    keys: {
      type: 'object', additionalProperties: false, required: ['p256dh', 'auth'],
      properties: { p256dh: { type: 'string', pattern: '^[A-Za-z0-9_-]{87}$' }, auth: { type: 'string', pattern: '^[A-Za-z0-9_-]{22}$' } },
    },
  },
};

export function registerPushRoutes(app: FastifyInstance, { db, vapidPublicKey }: { db: Database; vapidPublicKey: string | null }) {
  // What the browser needs to subscribe. 404 when push isn't set up.
  app.get('/push/key', async (_req, reply) => {
    if (!vapidPublicKey) return fail(reply, 404, 'push_off', 'Notifications aren’t available yet.');
    reply.header('cache-control', 'public, max-age=3600');
    return { publicKey: vapidPublicKey };
  });

  app.put('/me/push', {
    config: { auth: 'required', write: true },
    schema: { body: subscriptionSchema },
  }, async (req, reply) => {
    const user = signedIn(req);
    if (!vapidPublicKey) return fail(reply, 404, 'push_off', 'Notifications aren’t available yet.');
    const { endpoint, keys } = req.body as { endpoint: string; keys: { p256dh: string; auth: string } };
    if (!isPushService(endpoint)) return fail(reply, 400, 'not_a_push_service', 'This browser’s notification service isn’t supported.');
    const outcome = await db.withUser(user.id, async q => {
      const mine = (await q.query('SELECT 1 FROM app.push_subscriptions WHERE endpoint = $1', [endpoint])).rowCount;
      if (mine) return 'ok' as const;
      try {
        await q.query('SAVEPOINT add');
        await q.query('INSERT INTO app.push_subscriptions (profile_id, endpoint, p256dh, auth) VALUES ($1, $2, $3, $4)', [user.id, endpoint, keys.p256dh, keys.auth]);
        return 'ok' as const;
      } catch (err) {
        await q.query('ROLLBACK TO SAVEPOINT add');
        // The same browser is registered to another account (someone else
        // used this device): never send their notifications here. The
        // website makes a fresh subscription and tries again.
        if (pgCode(err) === '23505') return 'in_use' as const;
        if (pgCode(err) === '23514') return 'too_many' as const;
        throw err;
      }
    });
    if (outcome === 'in_use') return fail(reply, 409, 'device_in_use', 'This browser gets another account’s notifications. Try again.');
    if (outcome === 'too_many') return fail(reply, 409, 'too_many_devices', 'Notifications are on for 10 devices already. Turn them off on one first.');
    return { push: { on: true } };
  });

  // Whether this browser gets the signed-in person's notifications. The
  // browser alone can't tell: its subscription may belong to whoever used it
  // before. A POST so the address stays out of URLs and logs.
  app.post('/me/push/status', {
    config: { auth: 'required' },
    schema: { body: endpointSchema },
  }, async req => {
    const user = signedIn(req);
    const { endpoint } = req.body as { endpoint: string };
    const { rowCount } = await db.withUser(user.id, q => q.query('SELECT 1 FROM app.push_subscriptions WHERE endpoint = $1 AND profile_id = $2', [endpoint, user.id]));
    return { push: { on: rowCount === 1 } };
  });

  app.delete('/me/push', {
    config: { auth: 'required', write: true },
    schema: { body: endpointSchema },
  }, async req => {
    const user = signedIn(req);
    const { endpoint } = req.body as { endpoint: string };
    await db.withUser(user.id, q => q.query('DELETE FROM app.push_subscriptions WHERE endpoint = $1', [endpoint]));
    return { push: { on: false } };
  });
}
