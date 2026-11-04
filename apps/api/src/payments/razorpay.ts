// Razorpay, called directly over HTTPS (no SDK, as with Supabase): payment links and webhook checks (ADR 0034).
// Facts from Razorpay's own documentation and its Node SDK source, checked 2026-11-04:
// - POST https://api.razorpay.com/v1/payment_links with Basic auth (key id : key secret); amount in paise, at most
//   40 characters of reference_id, unique per link; the reply's `id` starts plink_, `short_url` is the link.
// - Webhooks: X-Razorpay-Signature is the hex HMAC-SHA256 of the raw body with the webhook secret; the same event can
//   arrive more than once (x-razorpay-event-id) and out of order. payment_link.paid carries
//   payload.payment_link.entity { id, reference_id, amount, amount_paid, currency, status } and
//   payload.payment.entity { id, amount, status }.
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { RazorpayKeys } from '../config.ts';

export type PaymentFetcher = (
  url: string,
  init: { method: 'POST'; headers: Record<string, string>; body: string; signal: AbortSignal; redirect: 'error' },
) => Promise<{ status: number; json(): Promise<unknown> }>;

export interface PaymentLink {
  id: string;
  url: string;
}

export class PaymentProviderError extends Error {
  override name = 'PaymentProviderError';
}

const TIMEOUT_MS = 10_000;
const LINK_ID = /^plink_[A-Za-z0-9]{1,40}$/;
const LINK_URL = /^https:\/\/([a-z0-9-]+\.)*(rzp\.io|razorpay\.com)\//;

/** One payment link. Throws PaymentProviderError, never with Razorpay's words (they can echo what was sent). */
export async function createPaymentLink(
  fetcher: PaymentFetcher,
  keys: RazorpayKeys,
  link: { amountPaise: number; referenceId: string; description: string; expireBy: number },
): Promise<PaymentLink> {
  const res = await fetcher('https://api.razorpay.com/v1/payment_links', {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(`${keys.keyId}:${keys.keySecret}`).toString('base64')}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      amount: link.amountPaise,
      currency: 'INR',
      reference_id: link.referenceId,
      description: link.description,
      expire_by: link.expireBy,
      // Graphinity sends no name, email or phone: the payer types them on Razorpay's page if Razorpay needs them.
      notify: { sms: false, email: false },
      reminder_enable: false,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
    redirect: 'error',
  });
  if (res.status !== 200) throw new PaymentProviderError(`Razorpay answered ${String(res.status)}`);
  const body = (await res.json()) as { id?: unknown; short_url?: unknown };
  if (
    typeof body.id !== 'string' ||
    !LINK_ID.test(body.id) ||
    typeof body.short_url !== 'string' ||
    !LINK_URL.test(body.short_url)
  )
    throw new PaymentProviderError('Razorpay answered with an unexpected link');
  return { id: body.id, url: body.short_url };
}

/** Whether `signature` is Razorpay's for exactly these bytes, compared in constant time. */
export function verifyWebhook(rawBody: Buffer, signature: string | undefined, secret: string): boolean {
  if (!signature || !/^[0-9a-f]{64}$/.test(signature)) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  return timingSafeEqual(expected, Buffer.from(signature, 'hex'));
}

export interface LinkEvent {
  event: 'payment_link.paid' | 'payment_link.partially_paid' | 'payment_link.expired' | 'payment_link.cancelled';
  linkId: string;
  referenceId: string;
  amountPaise: number;
  amountPaidPaise: number;
  currency: string;
  paymentId: string | null;
}

const EVENTS = new Set<string>([
  'payment_link.paid',
  'payment_link.partially_paid',
  'payment_link.expired',
  'payment_link.cancelled',
]);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const whole = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

/** A payment link event, or null for anything else (other events, or a shape Razorpay doesn't send). */
export function parseLinkEvent(body: unknown): LinkEvent | null {
  if (!isRecord(body) || typeof body.event !== 'string' || !EVENTS.has(body.event)) return null;
  const payload = isRecord(body.payload) ? body.payload : {};
  const link =
    isRecord(payload.payment_link) && isRecord(payload.payment_link.entity) ? payload.payment_link.entity : null;
  const payment = isRecord(payload.payment) && isRecord(payload.payment.entity) ? payload.payment.entity : null;
  if (
    !link ||
    typeof link.id !== 'string' ||
    !LINK_ID.test(link.id) ||
    typeof link.reference_id !== 'string' ||
    !whole(link.amount) ||
    !whole(link.amount_paid) ||
    typeof link.currency !== 'string'
  )
    return null;
  const paymentId =
    payment && typeof payment.id === 'string' && /^pay_[A-Za-z0-9]{1,40}$/.test(payment.id) ? payment.id : null;
  return {
    event: body.event as LinkEvent['event'],
    linkId: link.id,
    referenceId: link.reference_id,
    amountPaise: link.amount,
    amountPaidPaise: link.amount_paid,
    currency: link.currency,
    paymentId,
  };
}
