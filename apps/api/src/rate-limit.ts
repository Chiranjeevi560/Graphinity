import { createHmac } from 'node:crypto';

export interface Clock {
  /** Milliseconds since the epoch. */
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

export interface BucketOptions {
  /** Requests allowed in a burst. */
  capacity: number;
  /** Requests regained per second. */
  refillPerSecond: number;
  /**
   * Most keys remembered at once. Bounds memory when someone sprays requests
   * from many addresses; the oldest-touched keys are forgotten first.
   */
  maxKeys: number;
}

export type TakeResult = { ok: true } | { ok: false; retryAfterSeconds: number };

/**
 * Token buckets kept in memory. The free server is a single instance, so
 * memory is the only state it needs; a restart forgets the counts, which only
 * ever errs towards letting people in. Durable limits (posts per day) live in
 * the database instead.
 */
export class TokenBuckets {
  // Map keeps insertion order; re-inserting on each touch makes the first
  // entry the least recently used.
  readonly #buckets = new Map<string, { tokens: number; at: number }>();
  readonly #options: BucketOptions;
  readonly #clock: Clock;

  constructor(options: BucketOptions, clock: Clock) {
    this.#options = options;
    this.#clock = clock;
  }

  take(key: string, cost = 1): TakeResult {
    const now = this.#clock.now();
    const { capacity, refillPerSecond, maxKeys } = this.#options;
    const prev = this.#buckets.get(key);
    let tokens = capacity;
    if (prev) {
      // A wall clock can step backwards (time sync); never let that drain a bucket.
      const elapsed = Math.max(0, now - prev.at);
      tokens = Math.min(capacity, prev.tokens + (elapsed / 1000) * refillPerSecond);
      this.#buckets.delete(key);
    }
    if (tokens < cost) {
      this.#buckets.set(key, { tokens, at: now });
      return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((cost - tokens) / refillPerSecond)) };
    }
    this.#buckets.set(key, { tokens: tokens - cost, at: now });
    if (this.#buckets.size > maxKeys) {
      const oldest = this.#buckets.keys().next().value;
      if (oldest !== undefined) this.#buckets.delete(oldest);
    }
    return { ok: true };
  }

  get size(): number {
    return this.#buckets.size;
  }
}

/**
 * A stable, non-reversible key for a visitor's address. Used for rate limits
 * and, later, duplicate reports; the address itself is never stored or logged.
 */
export function visitorKey(address: string, key: Buffer): string {
  return createHmac('sha256', key).update(address).digest('base64url').slice(0, 22);
}
