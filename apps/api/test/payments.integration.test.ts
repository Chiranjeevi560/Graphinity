// Payments (ADR 0034) through the real server and Postgres as the restricted role, against a stand-in for Razorpay
// that answers as its documentation says and signs webhooks with the same algorithm. Off by default; only the owner
// of an advertiser (or the platform) asks; only a correctly signed webhook marks anything paid, once, and forward only.
import { createHmac, randomBytes } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { RazorpayKeys } from '../src/config.ts';
import type { PaymentFetcher } from '../src/payments/razorpay.ts';
import { startApp, type TestApp } from './helpers/app.ts';
import { must } from './helpers/must.ts';
import { sweepStalePayments } from '../src/payments/sweep.ts';

// Made for this run, so no key-shaped text sits in the repository for the secret scan to (rightly) flag.
const keys: RazorpayKeys = {
  keyId: 'rzp_test_ABCDEFGH1234',
  keySecret: randomBytes(16).toString('hex'),
  webhookSecret: randomBytes(16).toString('hex'),
};
let h: TestApp;
let on = false;
let n = 0;
let razorpayUp = true;
const sent: Array<{ url: string; auth: string; body: Record<string, unknown> }> = [];

const fetcher: PaymentFetcher = (url, init) => {
  const body = JSON.parse(init.body) as Record<string, unknown>;
  sent.push({ url, auth: init.headers.authorization ?? '', body });
  if (!razorpayUp)
    return Promise.resolve({ status: 500, json: () => Promise.resolve({ error: { description: 'down' } }) });
  const id = `plink_${String(sent.length).padStart(6, 'A')}`;
  return Promise.resolve({
    status: 200,
    json: () => Promise.resolve({ id, short_url: `https://rzp.io/rzp/${id}`, status: 'created', ...body }),
  });
};

beforeAll(async () => {
  h = await startApp(() => Date.now(), {
    adsEnabled: () => true,
    paymentsEnabled: () => on,
    razorpay: { keys, fetcher },
  });
  await h.t.owner.query("UPDATE app.feature_flags SET enabled = true WHERE name = 'ads'");
  return h.close;
});

const setPayments = async (value: boolean) => {
  on = value;
  await h.t.owner.query("UPDATE app.feature_flags SET enabled = $1 WHERE name = 'payments'", [value]);
};

async function member() {
  const p = await h.person();
  n += 1;
  expect(
    (
      await h.call('POST', '/me/profile', p.token, {
        handle: `pay.${String(n)}`,
        country: 'IN',
        fields: ['travel'],
        adult: true,
      })
    ).statusCode,
  ).toBe(201);
  await h.t.owner.query("UPDATE app.profiles SET created_at = now() - interval '2 days' WHERE id = $1", [p.id]);
  return p;
}
async function advertiser() {
  const owner = await member();
  const res = await h.call('POST', '/ads/advertisers', owner.token, { name: `Shop ${String(n)}`, country: 'IN' });
  expect(res.statusCode).toBe(201);
  return { owner, id: res.json<{ advertiser: { id: string } }>().advertiser.id };
}

function webhook(event: object, opts: { secret?: string; eventId?: string; signature?: string } = {}) {
  const raw = JSON.stringify(event);
  const signature =
    opts.signature ??
    createHmac('sha256', opts.secret ?? keys.webhookSecret)
      .update(raw)
      .digest('hex');
  return h.app.inject({
    method: 'POST',
    url: '/payments/razorpay/webhook',
    headers: {
      'content-type': 'application/json',
      'x-razorpay-signature': signature,
      'x-razorpay-event-id': opts.eventId ?? `evt_${String(Math.random()).slice(2)}`,
    },
    payload: raw,
  });
}
function linkEvent(kind: string, link: { id: string; ref: string; amount: number; paid: number }, currency = 'INR') {
  return {
    event: `payment_link.${kind}`,
    payload: {
      payment_link: {
        entity: {
          id: link.id,
          reference_id: link.ref,
          amount: link.amount,
          amount_paid: link.paid,
          currency,
          status: kind,
        },
      },
      payment: { entity: { id: 'pay_TEST000001', amount: link.paid, status: 'captured' } },
    },
  };
}
async function stored(ref: string) {
  return must(
    (
      await h.t.owner.query<{ status: string; paid: number; link: string; payment: string | null }>(
        `SELECT status, amount_paid_paise AS paid, provider_link_id AS link, provider_payment_id AS payment
         FROM app.payments WHERE public_id = $1`,
        [ref],
      )
    ).rows[0],
  );
}

describe('payments', () => {
  it('are off by default, in the API and in the database', async () => {
    const a = await advertiser();
    const res = await h.call('POST', `/ads/advertisers/${a.id}/payments`, a.owner.token, { amountPaise: 50000 });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'payments_off' });
    // The API's switch on, the database's off: the database refuses the row.
    on = true;
    try {
      expect(
        (await h.call('POST', `/ads/advertisers/${a.id}/payments`, a.owner.token, { amountPaise: 50000 })).statusCode,
      ).toBe(403);
    } finally {
      on = false;
    }
    expect(sent).toHaveLength(0);
  });

  it('make a Razorpay link for an advertiser’s owner, sending nothing about the payer', async () => {
    await setPayments(true);
    try {
      const a = await advertiser();
      const res = await h.call('POST', `/ads/advertisers/${a.id}/payments`, a.owner.token, { amountPaise: 50000 });
      expect(res.statusCode).toBe(201);
      const { payment } = res.json<{ payment: { id: string; url: string; status: string } }>();
      expect(payment).toMatchObject({ status: 'created', amountPaise: 50000 });
      expect(payment.url).toMatch(/^https:\/\/rzp\.io\//);
      const call = must(sent.at(-1));
      expect(call.url).toBe('https://api.razorpay.com/v1/payment_links');
      expect(call.auth).toBe(`Basic ${Buffer.from(`${keys.keyId}:${keys.keySecret}`).toString('base64')}`);
      expect(call.body).toMatchObject({ amount: 50000, currency: 'INR', reference_id: payment.id });
      expect(call.body).not.toHaveProperty('customer');
      expect((await stored(payment.id)).status).toBe('created');
      // Members see it; nobody else does.
      const list = await h.call('GET', `/ads/advertisers/${a.id}/payments`, a.owner.token);
      expect(list.json<{ payments: unknown[]; paidPaise: number }>()).toMatchObject({ paidPaise: 0 });
      const stranger = await member();
      expect((await h.call('GET', `/ads/advertisers/${a.id}/payments`, stranger.token)).json()).toMatchObject({
        payments: [],
      });
    } finally {
      await setPayments(false);
    }
  });

  it('refuse anyone but the advertiser’s owner (a stranger isn’t even told it exists), and amounts out of range', async () => {
    await setPayments(true);
    try {
      const a = await advertiser();
      const stranger = await member();
      expect(
        (await h.call('POST', `/ads/advertisers/${a.id}/payments`, stranger.token, { amountPaise: 50000 })).statusCode,
      ).toBe(404);
      expect(
        (await h.call('POST', `/ads/advertisers/${a.id}/payments`, a.owner.token, { amountPaise: 9999 })).statusCode,
      ).toBe(400);
      expect(
        (await h.call('POST', `/ads/advertisers/${a.id}/payments`, a.owner.token, { amountPaise: 10000001 }))
          .statusCode,
      ).toBe(400);
      // Straight to the database as the restricted role: no row for someone else's advertiser, and no marking paid.
      const ad = must(
        (await h.t.owner.query<{ id: string }>('SELECT id::text FROM app.ad_advertisers WHERE public_id = $1', [a.id]))
          .rows[0],
      ).id;
      await h.t.database.withUser(stranger.id, async q => {
        await expect(
          q.query(
            "INSERT INTO app.payments (purpose, advertiser_id, amount_paise, created_by) VALUES ('ad_credit', $1, 50000, $2)",
            [ad, stranger.id],
          ),
        ).rejects.toThrow();
      });
      await h.t.database.withUser(a.owner.id, async q => {
        expect(
          (await q.query("UPDATE app.payments SET status = 'paid', paid_at = now() WHERE advertiser_id = $1", [ad]))
            .rowCount,
        ).toBe(0);
      });
    } finally {
      await setPayments(false);
    }
  });

  it('mark a payment paid only on Razorpay’s signed word, once, and never undo it', async () => {
    await setPayments(true);
    try {
      const a = await advertiser();
      const { payment } = (
        await h.call('POST', `/ads/advertisers/${a.id}/payments`, a.owner.token, { amountPaise: 50000 })
      ).json<{
        payment: { id: string };
      }>();
      const link = { id: (await stored(payment.id)).link, ref: payment.id, amount: 50000, paid: 50000 };

      // Wrongly signed, or signed with another secret: nothing.
      expect((await webhook(linkEvent('paid', link), { signature: '0'.repeat(64) })).statusCode).toBe(401);
      expect((await webhook(linkEvent('paid', link), { secret: randomBytes(16).toString('hex') })).statusCode).toBe(
        401,
      );
      expect((await webhook(linkEvent('paid', link), { signature: 'not-hex' })).statusCode).toBe(401);
      // The wrong amount or currency, even signed: recorded as a mismatch, not paid.
      expect((await webhook(linkEvent('paid', { ...link, amount: 100 }))).statusCode).toBe(200);
      expect((await webhook(linkEvent('paid', link, 'USD'))).statusCode).toBe(200);
      // "Paid" for less than was asked, or for nothing: not paid either.
      expect((await webhook(linkEvent('paid', { ...link, paid: 10000 }))).statusCode).toBe(200);
      expect((await webhook(linkEvent('paid', { ...link, paid: 0 }))).statusCode).toBe(200);
      // Another link claiming our reference: refused.
      expect((await webhook(linkEvent('paid', { ...link, id: 'plink_SOMEONEELSE1' }))).statusCode).toBe(200);
      expect((await stored(payment.id)).status).toBe('created');
      // The database refuses "paid" for less than the whole amount too, whoever writes it.
      await expect(
        h.t.owner.query(
          "UPDATE app.payments SET status = 'paid', paid_at = now(), amount_paid_paise = 10000 WHERE public_id = $1",
          [payment.id],
        ),
      ).rejects.toThrow();
      // Signed, and matching: paid.
      expect((await webhook(linkEvent('paid', link))).statusCode).toBe(200);
      expect(await stored(payment.id)).toMatchObject({ status: 'paid', paid: 50000, payment: 'pay_TEST000001' });

      // A late "expired" doesn't undo it; the same event twice is acted on once; the database refuses to un-pay.
      expect((await webhook(linkEvent('expired', { ...link, paid: 50000 }))).statusCode).toBe(200);
      expect((await stored(payment.id)).status).toBe('paid');
      await expect(
        h.t.owner.query("UPDATE app.payments SET status = 'expired', paid_at = NULL WHERE public_id = $1", [
          payment.id,
        ]),
      ).rejects.toThrow(/stays paid/);
      const list = await h.call('GET', `/ads/advertisers/${a.id}/payments`, a.owner.token);
      expect(list.json<{ paidPaise: number }>().paidPaise).toBe(50000);
      // The person who asked gets it in their data export, with no card or bank details (none are kept).
      const exported = await h.call('GET', '/me/data-export', a.owner.token);
      expect(exported.json<{ payments: unknown[] }>().payments).toEqual([
        expect.objectContaining({
          id: payment.id,
          purpose: 'ad_credit',
          amountPaise: 50000,
          paidPaise: 50000,
          status: 'paid',
        }),
      ]);
    } finally {
      await setPayments(false);
    }
  });

  it('act on one event id once, even if Razorpay sends it again', async () => {
    await setPayments(true);
    try {
      const a = await advertiser();
      const { payment } = (
        await h.call('POST', `/ads/advertisers/${a.id}/payments`, a.owner.token, { amountPaise: 80000 })
      ).json<{
        payment: { id: string };
      }>();
      const link = { id: (await stored(payment.id)).link, ref: payment.id, amount: 80000, paid: 30000 };
      expect((await webhook(linkEvent('partially_paid', link), { eventId: 'evt_once' })).statusCode).toBe(200);
      expect((await stored(payment.id)).paid).toBe(30000);
      // The same id again, now claiming more: ignored.
      expect(
        (await webhook(linkEvent('partially_paid', { ...link, paid: 70000 }), { eventId: 'evt_once' })).statusCode,
      ).toBe(200);
      expect(await stored(payment.id)).toMatchObject({ status: 'partially_paid', paid: 30000 });
      // A late "expired" keeps what was paid, and the status that says so.
      expect((await webhook(linkEvent('expired', link))).statusCode).toBe(200);
      expect(await stored(payment.id)).toMatchObject({ status: 'partially_paid', paid: 30000 });
    } finally {
      await setPayments(false);
    }
  });

  it('leave a payment failed when Razorpay can’t make the link, and say so plainly', async () => {
    await setPayments(true);
    razorpayUp = false;
    try {
      const a = await advertiser();
      const res = await h.call('POST', `/ads/advertisers/${a.id}/payments`, a.owner.token, { amountPaise: 50000 });
      expect(res.statusCode).toBe(502);
      expect(res.json()).toMatchObject({ error: 'provider_failed' });
      expect(JSON.stringify(res.json())).not.toContain('down');
      const { rows } = await h.t.owner.query<{ status: string }>(
        'SELECT p.status FROM app.payments p JOIN app.ad_advertisers a ON a.id = p.advertiser_id WHERE a.public_id = $1',
        [a.id],
      );
      expect(rows.map(r => r.status)).toEqual(['failed']);
      // Razorpay made the link after all, and it was paid: the signed event still records the money.
      const ref = must(
        (
          await h.t.owner.query<{ id: string }>(
            'SELECT p.public_id::text AS id FROM app.payments p JOIN app.ad_advertisers a ON a.id = p.advertiser_id WHERE a.public_id = $1',
            [a.id],
          )
        ).rows[0],
      ).id;
      const late = { id: 'plink_LATELINK0001', ref, amount: 50000, paid: 50000 };
      expect((await webhook(linkEvent('paid', late))).statusCode).toBe(200);
      expect(await stored(ref)).toMatchObject({ status: 'paid', link: 'plink_LATELINK0001', paid: 50000 });
    } finally {
      razorpayUp = true;
      await setPayments(false);
    }
  });

  it('lets only the platform’s owner ask an organization to pay for its plan', async () => {
    await setPayments(true);
    try {
      const o = await member();
      await h.t.owner.query('INSERT INTO app.platform_owners (profile_id) VALUES ($1)', [o.id]);
      const org = (await h.call('POST', '/owner/enterprise/orgs', o.token, { name: 'Phone Research Ltd' })).json<{
        org: { id: string };
      }>().org.id;
      const someone = await member();
      expect(
        (await h.call('POST', `/owner/enterprise/orgs/${org}/payments`, someone.token, { amountPaise: 500000 }))
          .statusCode,
      ).toBe(404);
      const res = await h.call('POST', `/owner/enterprise/orgs/${org}/payments`, o.token, { amountPaise: 500000 });
      expect(res.statusCode).toBe(201);
      expect(must(sent.at(-1)).body).toMatchObject({
        amount: 500000,
        description: 'Graphinity enterprise analytics plan',
      });
    } finally {
      await setPayments(false);
    }
  });

  it('mark a payment stuck asking Razorpay for over an hour as failed, and leave newer ones', async () => {
    await setPayments(true);
    try {
      const a = await advertiser();
      const ad = must(
        (await h.t.owner.query<{ id: string }>('SELECT id::text FROM app.ad_advertisers WHERE public_id = $1', [a.id]))
          .rows[0],
      ).id;
      const { rows } = await h.t.owner.query<{ id: string; old: boolean }>(
        `INSERT INTO app.payments (purpose, advertiser_id, amount_paise, created_by, created_at)
         VALUES ('ad_credit', $1, 50000, $2, now() - interval '2 hours'), ('ad_credit', $1, 50000, $2, now())
         RETURNING public_id::text AS id, created_at < now() - interval '1 hour' AS old`,
        [ad, a.owner.id],
      );
      expect(await sweepStalePayments(h.t.database)).toBeGreaterThanOrEqual(1);
      for (const r of rows) expect((await stored(r.id)).status).toBe(r.old ? 'failed' : 'creating');
    } finally {
      await setPayments(false);
    }
  });
});
