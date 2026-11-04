// Payments (ADR 0034): asking for a Razorpay payment link, and Razorpay's webhook saying it was paid. Off unless the
// `payments` switch is on and the server has Razorpay keys. The database repeats every rule (migration 0071): who
// may ask, the amounts, and that a payment only moves forward.
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { RazorpayKeys } from '../config.ts';
import type { Database, Queryable } from '../db.ts';
import { createPaymentLink, parseLinkEvent, verifyWebhook, type PaymentFetcher } from '../payments/razorpay.ts';
import { audit, auditWithin } from '../platform/jobs.ts';
import { fail, pgCode, signedIn } from './common.ts';

export interface PaymentsDeps {
  db: Database;
  enabled: () => boolean;
  /** Null without Razorpay keys: then nothing can be asked for, and webhooks are refused. */
  razorpay: { keys: RazorpayKeys; fetcher: PaymentFetcher } | null;
  now: () => number;
}

const LINK_DAYS = 7;
const amount = { type: 'integer', minimum: 10000, maximum: 10000000 };
const DESCRIPTIONS = { ad_credit: 'Graphinity ad credit', enterprise: 'Graphinity enterprise analytics plan' } as const;

export function registerPaymentRoutes(app: FastifyInstance, deps: PaymentsDeps) {
  const { db } = deps;
  const off = (reply: FastifyReply) => fail(reply, 404, 'payments_off', 'Payments on Graphinity aren’t available yet.');

  /** Records the ask, gets Razorpay's link, then records the link. A failed call leaves the payment `failed`. */
  async function ask(
    reply: FastifyReply,
    userId: string,
    purpose: keyof typeof DESCRIPTIONS,
    insert: (q: Queryable) => Promise<{ id: string; publicId: string } | 'missing'>,
    amountPaise: number,
  ) {
    const razorpay = deps.razorpay;
    if (!deps.enabled() || !razorpay) return off(reply);
    let made: { id: string; publicId: string } | 'missing' | 'forbidden';
    try {
      made = await db.withUser(userId, async q => {
        const row = await insert(q);
        if (row !== 'missing')
          await auditWithin(q, {
            action: 'payment.asked',
            actor: 'person',
            subject: row.publicId,
            detail: { purpose, amountPaise },
          });
        return row;
      });
    } catch (err) {
      if (pgCode(err) === '42501') made = 'forbidden';
      else throw err;
    }
    if (made === 'missing') return fail(reply, 404, 'not_found', 'There’s nothing by that id you can pay for.');
    if (made === 'forbidden') return fail(reply, 403, 'forbidden', 'Only its owner can pay for this.');
    const payment = made;
    let link;
    try {
      link = await createPaymentLink(razorpay.fetcher, razorpay.keys, {
        amountPaise,
        referenceId: payment.publicId,
        description: DESCRIPTIONS[purpose],
        expireBy: Math.floor(deps.now() / 1000) + LINK_DAYS * 86_400,
      });
    } catch {
      // Only if nothing has happened since: Razorpay may have made the link after our timeout, and been paid.
      await db.asSystem(q =>
        q.query("UPDATE app.payments SET status = 'failed' WHERE id = $1 AND status = 'creating'", [payment.id]),
      );
      return fail(
        reply,
        502,
        'provider_failed',
        'Razorpay couldn’t make a payment link just now. Try again in a minute.',
      );
    }
    await db.asSystem(q =>
      // The webhook may have got here first (it adopts the link from Razorpay's signed event): keep what it recorded.
      q.query(
        `UPDATE app.payments SET status = CASE WHEN status = 'creating' THEN 'created' ELSE status END,
           provider_link_id = coalesce(provider_link_id, $2), link_url = coalesce(link_url, $3) WHERE id = $1`,
        [payment.id, link.id, link.url],
      ),
    );
    return reply.code(201).send({ payment: { id: payment.publicId, status: 'created', amountPaise, url: link.url } });
  }

  // An advertiser's owner buys ad credit. The link opens Razorpay's page; nothing about the payer is sent to it.
  app.post(
    '/ads/advertisers/:id/payments',
    {
      config: { auth: 'required', write: true, freshAuth: true },
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['amountPaise'],
          properties: { amountPaise: amount },
        },
      },
    },
    async (req, reply) => {
      const user = signedIn(req);
      const { id } = req.params as { id: string };
      const { amountPaise } = req.body as { amountPaise: number };
      return ask(
        reply,
        user.id,
        'ad_credit',
        async q => {
          const advertiser = (
            await q.query<{ id: string }>('SELECT id::text FROM app.ad_advertisers WHERE public_id = $1', [id])
          ).rows[0];
          if (!advertiser) return 'missing';
          const row = (
            await q.query<{ id: string; publicId: string }>(
              `INSERT INTO app.payments (purpose, advertiser_id, amount_paise, created_by) VALUES ('ad_credit', $1, $2, $3)
               RETURNING id::text, public_id::text AS "publicId"`,
              [advertiser.id, amountPaise, user.id],
            )
          ).rows[0];
          return row ?? 'missing';
        },
        amountPaise,
      );
    },
  );

  // An advertiser's members see what it has paid: credit is what was paid, not what was asked.
  app.get(
    '/ads/advertisers/:id/payments',
    {
      config: { auth: 'required' },
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
      },
    },
    async req => {
      const { id } = req.params as { id: string };
      const rows = await db.withUser(
        signedIn(req).id,
        async q =>
          (
            await q.query<{ id: string; status: string; amountPaise: number; paidPaise: number; at: string }>(
              `SELECT p.public_id::text AS id, p.status, p.amount_paise AS "amountPaise", p.amount_paid_paise AS "paidPaise",
                    p.created_at AS at
             FROM app.payments p JOIN app.ad_advertisers a ON a.id = p.advertiser_id
             WHERE a.public_id = $1 AND app.is_ad_member(a.id) ORDER BY p.id DESC LIMIT 100`,
              [id],
            )
          ).rows,
      );
      // The total over every payment, not only the 100 listed.
      const total = await db.withUser(signedIn(req).id, async q =>
        Number(
          (
            await q.query<{ paid: string }>(
              `SELECT coalesce(sum(p.amount_paid_paise), 0)::text AS paid
               FROM app.payments p JOIN app.ad_advertisers a ON a.id = p.advertiser_id
               WHERE a.public_id = $1 AND app.is_ad_member(a.id)`,
              [id],
            )
          ).rows[0]?.paid ?? 0,
        ),
      );
      return { payments: rows, paidPaise: total };
    },
  );

  // The owner asks an organization to pay for its plan, then sends it the link.
  app.post(
    '/owner/enterprise/orgs/:id/payments',
    {
      config: { auth: 'required', write: true, freshAuth: true },
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['amountPaise'],
          properties: { amountPaise: amount },
        },
      },
    },
    async (req, reply) => {
      const user = signedIn(req);
      const { id } = req.params as { id: string };
      const { amountPaise } = req.body as { amountPaise: number };
      return ask(
        reply,
        user.id,
        'enterprise',
        async q => {
          const org = (
            await q.query<{ id: string }>('SELECT id::text FROM app.enterprise_orgs WHERE public_id = $1', [id])
          ).rows[0];
          if (!org) return 'missing';
          const row = (
            await q.query<{ id: string; publicId: string }>(
              `INSERT INTO app.payments (purpose, org_id, amount_paise, created_by) VALUES ('enterprise', $1, $2, $3)
               RETURNING id::text, public_id::text AS "publicId"`,
              [org.id, amountPaise, user.id],
            )
          ).rows[0];
          return row ?? 'missing';
        },
        amountPaise,
      );
    },
  );

  // Razorpay's webhook: the only thing that marks a payment paid. Its own scope keeps the raw bytes, which the
  // signature covers. It works whenever keys are set, even with the switch off, so a link already paid is recorded.
  return app.register((hook, _options, ready) => {
    hook.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: 65_536 }, (_req, body, done) => {
      done(null, body);
    });
    hook.post('/payments/razorpay/webhook', async (req, reply) => {
      const razorpay = deps.razorpay;
      if (!razorpay) return off(reply);
      const raw = req.body;
      const signature = req.headers['x-razorpay-signature'];
      const eventId = req.headers['x-razorpay-event-id'];
      if (
        !Buffer.isBuffer(raw) ||
        !verifyWebhook(raw, typeof signature === 'string' ? signature : undefined, razorpay.keys.webhookSecret)
      )
        return fail(reply, 401, 'bad_signature', 'That isn’t signed by Razorpay.');
      if (typeof eventId !== 'string' || eventId.length < 1 || eventId.length > 100)
        return fail(reply, 400, 'bad_event', 'The event has no id.');
      let body: unknown;
      try {
        body = JSON.parse(raw.toString('utf8'));
      } catch {
        return fail(reply, 400, 'bad_event', 'The event isn’t JSON.');
      }
      const event = parseLinkEvent(body);
      await db.asSystem(async q => {
        const fresh = await q.query(
          'INSERT INTO app.payment_events (event_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING 1',
          [eventId],
        );
        // Seen before, or not about a payment link: nothing more to do.
        if (!fresh.rowCount || !event) return;
        // Found by our reference. A payment whose link we never recorded (our call timed out, or this event beat the
        // update) takes the link from Razorpay's signed event, so the money is never lost; a different link is refused.
        const payment = (
          await q.query<{ id: string; amount: number; status: string; link: string | null }>(
            `SELECT id::text, amount_paise AS amount, status, provider_link_id AS link FROM app.payments
             WHERE public_id::text = $1 FOR UPDATE`,
            [event.referenceId],
          )
        ).rows[0];
        if (!payment) return;
        if (
          (payment.link !== null && payment.link !== event.linkId) ||
          event.currency !== 'INR' ||
          event.amountPaise !== payment.amount ||
          event.amountPaidPaise > payment.amount ||
          // Paid means paid in full.
          (event.event === 'payment_link.paid' && event.amountPaidPaise !== payment.amount)
        ) {
          await audit(q, {
            action: 'payment.mismatch',
            actor: 'razorpay',
            subject: event.linkId,
            detail: { event: event.event },
          });
          return;
        }
        if (payment.link === null)
          await q.query(
            "UPDATE app.payments SET provider_link_id = $2, status = CASE WHEN status IN ('creating', 'failed') THEN 'created' ELSE status END WHERE id = $1",
            [payment.id, event.linkId],
          );
        if (event.event === 'payment_link.paid')
          await q.query(
            `UPDATE app.payments SET status = 'paid', paid_at = coalesce(paid_at, now()),
               amount_paid_paise = greatest(amount_paid_paise, $2), provider_payment_id = coalesce(provider_payment_id, $3)
             WHERE id = $1`,
            [payment.id, event.amountPaidPaise, event.paymentId],
          );
        else if (event.event === 'payment_link.partially_paid')
          await q.query(
            `UPDATE app.payments SET status = CASE WHEN status = 'paid' THEN status ELSE 'partially_paid' END,
               amount_paid_paise = greatest(amount_paid_paise, $2) WHERE id = $1`,
            [payment.id, event.amountPaidPaise],
          );
        // Events arrive out of order: a late "expired" or "cancelled" never undoes a payment.
        else
          await q.query(
            "UPDATE app.payments SET status = $2 WHERE id = $1 AND status NOT IN ('paid', 'partially_paid')",
            [payment.id, event.event === 'payment_link.expired' ? 'expired' : 'cancelled'],
          );
        await audit(q, {
          action: `payment.${event.event.slice('payment_link.'.length)}`,
          actor: 'razorpay',
          subject: event.linkId,
          detail: {},
        });
      });
      return { ok: true };
    });
    ready();
  });
}
