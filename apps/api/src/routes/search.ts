// The Search screen's endpoint (ADR 0015 part 2). POST, so what someone
// searches for never appears in a URL, a browser history or a proxy's log.
// Results are questions anyone may see, each with the reasons it was found,
// in words: no numbers about other people (trust, reputation) reach the client.
import { recordAdInterest, SEARCH_WEIGHT, searchTopic } from '../ads/interests.ts';
import type { FastifyInstance } from 'fastify';
import type { Database } from '../db.ts';
import { RELATED_AT } from '../precheck.ts';
import { TokenBuckets, visitorAddress, visitorKey, type BucketOptions, type Clock } from '../rate-limit.ts';
import { serverTiming, type Found, type SearchEngine } from '../search/engine.ts';
import { recordOwnSearch } from '../search/history.ts';
import { improvementSince, recordOpen, recordSearch } from '../search/log.ts';
import { applySwap, chooseSwap } from '../search/interventions.ts';
import { INTERLEAVE_SHARE, NO_RANKERS, ordered, teamDraft, type Rankers } from '../search/rankers.ts';
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
  notRecorded: 'That search isn’t recorded, so there is nothing to add to it.',
} as const;

export function registerSearchRoutes(
  app: FastifyInstance,
  {
    db,
    engine,
    enabled,
    clock,
    limit,
    eventLimit,
    keySecret,
    random = Math.random,
    rankers = () => NO_RANKERS,
  }: {
    db: Pick<Database, 'withUser'>;
    engine: SearchEngine;
    /** The `search` kill switch. */
    enabled: () => boolean;
    clock: Clock;
    /** Searches per person (signed in) or per address (visitors), on top of the server-wide limits. */
    limit: BucketOptions;
    /** Opens and reading times per person: two per result read, so apart from searches. */
    eventLimit: BucketOptions;
    keySecret: Buffer;
    /** Chance for position-bias swaps and interleaving coins; tests pass their own. */
    random?: () => number;
    /** The learned rankings, when the owner has `learned_search_ranking` on (ADR 0015 part 6). */
    rankers?: () => Rankers;
  },
) {
  // Each search embeds text and runs three queries, so it gets its own allowance:
  // the general one is sized for page views, which cost far less.
  const buckets = new TokenBuckets(limit, clock);
  const eventBuckets = new TokenBuckets(eventLimit, clock);

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
      // Read before searching: a choice changed while the search runs records nothing.
      const since = userId ? await improvementSince(db, userId) : null;
      const { found, corrections, meaningUsed, meaningModel, timings } = await engine.retrieve({
        text: query,
        field,
        pool: SEARCH_POOL,
      });
      reply.header('server-timing', serverTiming(timings));
      // Only results with a reason are shown; the serving ranker orders them.
      const eligible = found.flatMap(f => {
        const reasons = reasonsFor(f);
        return reasons ? [{ f, reasons }] : [];
      });
      const reasonOf = new Map(eligible.map(e => [e.f.id, e.reasons]));
      const served = rankers();
      const recorded = Boolean(userId && since);
      const at = clock.now();
      const byProduction = ordered(
        served.production,
        eligible.map(e => e.f),
        at,
      );
      // While another ranker waits, half the recorded searches interleave the two; the rest
      // may measure position bias instead. Nobody else's results ever change.
      const interleave = recorded && served.challenger !== null && random() < INTERLEAVE_SHARE;
      let shown: Array<{ f: Found; reasons: Reason[]; rankedPosition: number; team?: 'a' | 'b' }>;
      let swap: number | null = null;
      if (interleave && served.challenger) {
        const byChallenger = ordered(
          served.challenger,
          eligible.map(e => e.f),
          at,
        );
        shown = teamDraft(byProduction, byChallenger, SEARCH_RESULTS, random).map(({ found: f, team }, i) => ({
          f,
          reasons: reasonOf.get(f.id) ?? [],
          rankedPosition: i + 1,
          team,
        }));
      } else {
        const ranked = byProduction
          .slice(0, SEARCH_RESULTS)
          .map((f, i) => ({ f, reasons: reasonOf.get(f.id) ?? [], rankedPosition: i + 1 }));
        swap = recorded ? chooseSwap(random, ranked.length) : null;
        shown = applySwap(ranked, swap);
      }
      const results = shown.map(({ f, reasons }) => ({
        id: f.id,
        title: f.title,
        field: { slug: f.field, name: f.fieldName },
        answerCount: f.answerCount,
        lastAnsweredAt: f.lastAnsweredAt?.toISOString() ?? null,
        reasons,
      }));
      // Only with "improve search for everyone" on; the database refuses it otherwise.
      const searchId =
        userId && since
          ? await recordSearch(db, {
              userId,
              since,
              query,
              field,
              meaningModel,
              shown: shown.map(({ f, rankedPosition, team }, i) => ({
                position: i + 1,
                rankedPosition,
                ...(team ? { team } : {}),
                found: f,
              })),
              swap,
              ranker: served.production.id,
              experiment: interleave && served.challenger ? `${served.production.id}/${served.challenger.id}` : null,
              now: new Date(clock.now()),
            })
          : null;
      // A signal for the person's advertising interests, only if they allow it (ADR 0022).
      const topic = userId
        ? searchTopic(
            field,
            results.map(r => r.field.slug),
          )
        : null;
      if (userId && topic) await recordAdInterest(db, req.log, userId, topic, SEARCH_WEIGHT);
      return { results, corrections, meaning: meaningUsed, ...(searchId ? { searchId } : {}) };
    },
  );

  // A result opened from a recorded search, and later how long it was read
  // (the page sends the time when it is left). Nothing to record answers 404.
  app.put(
    '/searches/:id/opens/:position',
    {
      config: { auth: 'required' },
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'position'],
          properties: {
            id: { type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' },
            position: { type: 'string', pattern: '^([1-9]|1[0-9]|20)$' },
          },
        },
        body: {
          type: 'object',
          additionalProperties: false,
          properties: { dwellMs: { type: 'integer', minimum: 0, maximum: 3_600_000 } },
        },
      },
    },
    async (req, reply) => {
      const user = req.user;
      if (!user) return fail(reply, 401, 'signed_out', 'You’re signed out. Sign in again to continue.');
      const allowed = eventBuckets.take(user.id);
      if (!allowed.ok) {
        reply.header('retry-after', String(allowed.retryAfterSeconds));
        return fail(reply, 429, 'rate_limited', messages.tooMany);
      }
      const { id, position } = req.params as { id: string; position: string };
      const dwell = (req.body as { dwellMs?: number } | undefined)?.dwellMs ?? null;
      const recorded = await recordOpen(db, {
        userId: user.id,
        searchId: id,
        position: Number(position),
        dwellMs: dwell,
      });
      if (!recorded) return fail(reply, 404, 'not_recorded', messages.notRecorded);
      return reply.code(204).send();
    },
  );
}
