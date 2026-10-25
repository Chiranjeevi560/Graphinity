// The Search screen's endpoint (ADR 0015 part 2). POST, so what someone
// searches for never appears in a URL, a browser history or a proxy's log.
// Results are questions anyone may see, each with the reasons it was found,
// in words: no numbers about other people (trust, reputation) reach the client.
import type { FastifyInstance } from 'fastify';
import type { Database } from '../db.ts';
import { RELATED_AT } from '../precheck.ts';
import { TokenBuckets, visitorAddress, visitorKey, type BucketOptions, type Clock } from '../rate-limit.ts';
import { serverTiming, type Found, type SearchEngine } from '../search/engine.ts';
import { recordOwnSearch } from '../search/history.ts';
import { cleanLine, textProblem } from '../text.ts';
import { fail } from './common.ts';

/** Candidates from each ranking before fusing: twice what is shown, so fusion has room to reorder. */
export const SEARCH_POOL = 50;
/** Results shown. */
export const SEARCH_RESULTS = 20;
/** People count characters, not bytes: a two-letter query ("UK", "GST") is a real one. */
export const QUERY_MIN = 2;
export const QUERY_MAX = 200;

/**
 * Why a result is there, in words the screen can say:
 * - every_word: it holds every word searched (as typed or as corrected);
 * - some_words: it holds some of them;
 * - meaning: close in meaning, at least as close as the spec's "related" (§11.1).
 */
export type Reason = 'every_word' | 'some_words' | 'meaning';

/**
 * Reasons, or null to leave it out. A result found by meaning alone is shown
 * only when it is close enough to call related (RELATED_AT); otherwise the
 * nearest questions to anything at all would fill the page with noise.
 */
export function reasonsFor(f: Found): Reason[] | null {
  const reasons: Reason[] = [];
  if (f.wordRank !== null) reasons.push(f.everyWord ? 'every_word' : 'some_words');
  if (f.meaningRank !== null && (f.similarity ?? 0) >= RELATED_AT) reasons.push('meaning');
  return reasons.length ? reasons : null;
}

const messages = {
  tooLong: `Searches can be up to ${String(QUERY_MAX)} characters. Shorten it and try again.`,
  invalid: 'That search has characters that can’t be searched. Remove them and try again.',
  off: 'Search is paused for a few minutes. Try again soon.',
  tooMany: 'That’s a lot of searches in a short time. Wait a minute, then try again.',
} as const;

export function registerSearchRoutes(
  app: FastifyInstance,
  {
    db,
    engine,
    enabled,
    clock,
    limit,
    keySecret,
  }: {
    db: Pick<Database, 'withUser'>;
    engine: SearchEngine;
    /** The `search` kill switch. */
    enabled: () => boolean;
    clock: Clock;
    /** Searches per person (signed in) or per address (visitors), on top of the server-wide limits. */
    limit: BucketOptions;
    keySecret: Buffer;
  },
) {
  // Each search embeds text and runs three queries, so it gets its own allowance:
  // the general one is sized for page views, which cost far less.
  const buckets = new TokenBuckets(limit, clock);

  app.post(
    '/search',
    {
      config: { auth: 'optional' },
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['query'],
          properties: {
            // Room for spaces that cleaning removes; the cleaned text is checked below.
            query: { type: 'string', maxLength: QUERY_MAX * 3 },
            field: { type: 'string', pattern: '^[a-z]+(-[a-z]+)*$', maxLength: 40 },
          },
        },
      },
    },
    async (req, reply) => {
      if (!enabled()) return fail(reply, 503, 'search_off', messages.off);
      const userId = req.user?.id ?? null;
      // Signed in: per person, so people behind one carrier address don't share one allowance.
      const allowed = buckets.take(userId ? `u:${userId}` : visitorKey(visitorAddress(req.ip), keySecret));
      if (!allowed.ok) {
        reply.header('retry-after', String(allowed.retryAfterSeconds));
        return fail(reply, 429, 'rate_limited', messages.tooMany);
      }
      const body = req.body as { query: string; field?: string };
      const query = cleanLine(body.query);
      const problem = textProblem(query, QUERY_MIN, QUERY_MAX);
      if (problem === 'too_short') return { results: [], corrections: [], meaning: false };
      if (problem === 'too_long') return fail(reply, 400, 'invalid_query', messages.tooLong, { reason: problem });
      if (problem) return fail(reply, 400, 'invalid_query', messages.invalid, { reason: problem });
      const field = body.field ?? null;
      if (userId) await recordOwnSearch(db, userId, 'search', query, field);
      const { found, corrections, meaningUsed, timings } = await engine.retrieve({
        text: query,
        field,
        pool: SEARCH_POOL,
      });
      reply.header('server-timing', serverTiming(timings));
      const results = found
        .flatMap(f => {
          const reasons = reasonsFor(f);
          return reasons ? [{ f, reasons }] : [];
        })
        .slice(0, SEARCH_RESULTS)
        .map(({ f, reasons }) => ({
          id: f.id,
          title: f.title,
          field: f.field,
          answerCount: f.answerCount,
          lastAnsweredAt: f.lastAnsweredAt?.toISOString() ?? null,
          reasons,
        }));
      return { results, corrections, meaning: meaningUsed };
    },
  );
}
