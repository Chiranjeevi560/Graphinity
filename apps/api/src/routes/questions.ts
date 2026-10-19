// Asking, answering and reading. Anyone can read; writing needs a profile.
// Every rule here is repeated in the database (db/schema.sql), which also
// refuses an answer to your own question even if this code forgot to check.
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Database } from '../db.ts';
import type { Events } from '../events.ts';
import { cleanBody, cleanLine, prefixQuery, textProblem, type TextProblem } from '../text.ts';
import { fail, pgCode, pgConstraint, signedIn } from './common.ts';
import { blockedMessage, isBlocked } from './moderation.ts';
import { consensus, reportedAmount, type Amount, type Claim } from '../consensus.ts';
import { vectorLiteral, type Embedder } from '../embeddings.ts';
import { fuse, verdict } from '../precheck.ts';
import { answerRank, specificity, wilsonLowerBound } from '../reputation.ts';
import { MAX_CHANGES, standing } from './points.ts';

/** The Bible's consensus bar appears once this many answers report an amount (§7.2 Screen 4). */
const CONSENSUS_MIN = 3;
/** Trust for someone not yet judged by 3 askers: neither trusted nor distrusted. */
const NEUTRAL_TRUST = 0.5;

export const LIMITS = {
  title: { min: 15, max: 150 },
  details: { min: 0, max: 5000 },
  answer: { min: 20, max: 10_000 },
};
const PAGE_SIZE = 20;
const SIMILAR_COUNT = 5;

// Ids are positive integers sent as text (Fastify's type coercion is off).
const idSchema = { type: 'string', pattern: '^[1-9][0-9]{0,15}$' };
const countrySchema = { type: 'string', pattern: '^[A-Z]{2}$' };
const fieldSchema = { type: 'string', pattern: '^[a-z]+(-[a-z]+)*$', maxLength: 40 };

const messages: Record<'title' | 'details' | 'answer', Record<TextProblem, string>> = {
  title: {
    too_short: `Write the question in full, at least ${LIMITS.title.min} characters.`,
    too_long: `Keep the question under ${LIMITS.title.max} characters. Put the rest in the details.`,
    invalid_characters: 'The question has characters that can’t be shown. Retype it and try again.',
  },
  details: {
    too_short: '',
    too_long: `Keep the details under ${LIMITS.details.max.toLocaleString('en')} characters.`,
    invalid_characters: 'The details have characters that can’t be shown. Retype them and try again.',
  },
  answer: {
    too_short: `Say a little more, at least ${LIMITS.answer.min} characters.`,
    too_long: `Keep the answer under ${LIMITS.answer.max.toLocaleString('en')} characters.`,
    invalid_characters: 'The answer has characters that can’t be shown. Retype it and try again.',
  },
};

// A signed-in writer may send up to this much; text is at most 4 bytes a character.
const WRITE_BODY_BYTES = 48 * 1024;

interface QuestionRow {
  id: string;
  title: string;
  body: string;
  field: string;
  field_name: string;
  country: string | null;
  country_name: string | null;
  asker: string;
  created_at: Date;
  answer_count: number;
}

// ponytail: answer counts are counted per row; keep a counter column when lists get slow.
const questionSelect = (extraColumns = '') => `
  SELECT ${extraColumns} q.id::text AS id, q.title, q.body, q.field, f.name AS field_name, q.country, c.name AS country_name,
         p.handle AS asker, q.created_at,
         (SELECT count(*) FROM app.answers a WHERE a.question_id = q.id)::int AS answer_count
  FROM app.questions q
  JOIN app.fields f ON f.slug = q.field
  JOIN app.profiles p ON p.id = q.asker_id
  LEFT JOIN app.countries c ON c.code = q.country`;

function summary(q: QuestionRow) {
  return {
    id: q.id,
    title: q.title,
    field: { slug: q.field, name: q.field_name },
    country: q.country ? { code: q.country, name: q.country_name } : null,
    asker: { handle: q.asker },
    createdAt: q.created_at.toISOString(),
    answerCount: q.answer_count,
  };
}

/** An INSERT … RETURNING always returns its row; anything else is a bug worth failing on. */
function inserted(rows: Array<{ id: string }>): string {
  const row = rows[0];
  if (!row) throw new Error('insert returned no row');
  return row.id;
}

const newAccountMessage = 'New accounts can ask 3 questions and give 10 answers on their first day. Try again tomorrow.';
const isNewAccountLimit = (err: unknown) => pgCode(err) === '23514' && (err as { hint?: string }).hint === 'new_account_limit';

function refuseText(reply: FastifyReply, what: keyof typeof messages, problem: TextProblem) {
  return fail(reply, 400, `invalid_${what}`, messages[what][problem], { reason: problem });
}

/** What a question means, in the words that matter: its title and the start of its details. */
export function questionText(title: string, details: string): string {
  return details ? `${title}\n${details.slice(0, 500)}` : title;
}

/** Candidates from each ranking before fusing (Bible §12.1 reranks the top 25). */
const PRECHECK_POOL = 25;

export function registerQuestionRoutes(app: FastifyInstance, { db, events, embedder }: { db: Database; events: Events; embedder: Embedder | null }) {
  /** An embedding, or null when there's no embedder or it failed: callers fall back to words. */
  async function embed(text: string): Promise<number[] | null> {
    if (!embedder) return null;
    try {
      return (await embedder.embed([text]))[0] ?? null;
    } catch {
      // Out of the free allowance, offline, or a changed format: words still work.
      return null;
    }
  }

  // Newest first, a page at a time. `before` is the last id of the previous page.
  app.get('/questions', {
    schema: { querystring: { type: 'object', additionalProperties: false, properties: { before: idSchema } } },
  }, async req => {
    const { before } = req.query as { before?: string };
    const rows = await db.withUser(null, async q => (await q.query<QuestionRow>(
      `${questionSelect()} WHERE ($1::bigint IS NULL OR q.id < $1::bigint) ORDER BY q.id DESC LIMIT ${PAGE_SIZE + 1}`,
      [before ?? null])).rows);
    const page = rows.slice(0, PAGE_SIZE);
    return { questions: page.map(summary), next: rows.length > PAGE_SIZE ? page.at(-1)?.id ?? null : null };
  });

  // For the sitemap (built by the website's host): the newest questions anyone may see.
  app.get('/sitemap/questions', async (_req, reply) => {
    const rows = await db.withUser(null, async q => (await q.query<{ id: string; title: string; created_at: Date }>(
      'SELECT q.id::text AS id, q.title, q.created_at FROM app.questions q ORDER BY q.id DESC LIMIT 5000')).rows);
    reply.header('cache-control', 'public, max-age=3600');
    return { questions: rows.map(r => ({ id: r.id, title: r.title, createdAt: r.created_at.toISOString() })) };
  });

  // While someone types a question: has it been asked already?
  // Bible §11.1 and Screen 2: while someone writes a question, has it been
  // asked already? Meaning and words, fused; "duplicate" offers the existing
  // answers first (they can still ask), "related" shows them alongside.
  app.post('/questions/precheck', {
    schema: {
      body: {
        type: 'object', additionalProperties: false, required: ['title'],
        properties: { title: { type: 'string', maxLength: 600 }, details: { type: 'string', maxLength: 12_000 }, field: fieldSchema },
      },
    },
  }, async req => {
    const body = req.body as { title: string; details?: string; field?: string };
    const title = cleanLine(body.title);
    // Too short to mean anything yet (counted as people count characters).
    if (textProblem(title, 10, Number.MAX_SAFE_INTEGER) === 'too_short') return { verdict: 'clear', questions: [] };
    const vector = await embed(questionText(title, cleanBody(body.details ?? '')));
    const words = prefixQuery(title);
    const field = body.field ?? null;
    const found = await db.withUser(null, async q => {
      const byMeaning = vector && embedder ? (await q.query<{ id: string; similarity: number }>(
        'SELECT id::text AS id, similarity FROM app.nearest_questions($1, $2, $3, $4)',
        [vectorLiteral(vector), embedder.model, field, PRECHECK_POOL])).rows : [];
      const byWords = words ? (await q.query<{ id: string }>(
        `SELECT q.id::text AS id FROM app.questions q, to_tsquery('english', $1) query
         WHERE q.search @@ query AND ($2::text IS NULL OR q.field = $2)
         ORDER BY ts_rank_cd(q.search, query) DESC, q.id DESC LIMIT ${String(PRECHECK_POOL)}`, [words, field])).rows : [];
      const ids = fuse(byMeaning.map(r => r.id), byWords.map(r => r.id)).slice(0, SIMILAR_COUNT);
      // Row-level security leaves out anything a visitor may not see.
      const details = ids.length ? (await q.query<{ id: string; title: string; answer_count: number; last_answered_at: Date | null }>(
        `SELECT q.id::text AS id, q.title,
                (SELECT count(*) FROM app.answers a WHERE a.question_id = q.id)::int AS answer_count,
                (SELECT max(a.created_at) FROM app.answers a WHERE a.question_id = q.id) AS last_answered_at
         FROM app.questions q WHERE q.id = ANY($1::bigint[])`, [ids])).rows : [];
      const similarity = new Map(byMeaning.map(r => [r.id, r.similarity]));
      const byId = new Map(details.map(d => [d.id, d]));
      return ids.flatMap(id => {
        const d = byId.get(id);
        return d ? [{ ...d, similarity: similarity.get(id) ?? null }] : [];
      });
    });
    const decision = verdict(found.map(f => ({ similarity: f.similarity, lastAnsweredAt: f.last_answered_at })), new Date(), vector !== null);
    return {
      verdict: decision,
      questions: decision === 'clear' ? [] : found.map(f => ({
        id: f.id, title: f.title, answerCount: f.answer_count,
        similarity: f.similarity === null ? null : Math.round(f.similarity * 100) / 100,
      })),
    };
  });

  app.get('/questions/similar', {
    schema: {
      querystring: {
        type: 'object', additionalProperties: false, required: ['q'],
        properties: { q: { type: 'string', maxLength: 300 } },
      },
    },
  }, async req => {
    const query = prefixQuery((req.query as { q: string }).q);
    if (!query) return { questions: [] };
    const rows = await db.withUser(null, async q => (await q.query<{ id: string; title: string; answer_count: number }>(
      `SELECT q.id::text AS id, q.title,
              (SELECT count(*) FROM app.answers a WHERE a.question_id = q.id)::int AS answer_count
       FROM app.questions q, to_tsquery('english', $1) query
       WHERE q.search @@ query
       ORDER BY ts_rank_cd(q.search, query) DESC, q.id DESC
       LIMIT ${SIMILAR_COUNT}`, [query])).rows);
    return { questions: rows.map(r => ({ id: r.id, title: r.title, answerCount: r.answer_count })) };
  });

  app.get('/questions/:id', {
    // Signed in is optional: it only marks the question seen if it was put to you.
    config: { auth: 'optional' },
    schema: { params: { type: 'object', properties: { id: idSchema }, required: ['id'] } },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const viewer = req.user?.id ?? null;
    const found = await db.withUser(viewer, async q => {
      if (viewer) await q.query('UPDATE app.routes SET seen_at = now() WHERE question_id = $1 AND profile_id = $2 AND seen_at IS NULL', [id, viewer]);
      const question = (await q.query<QuestionRow & { hidden: boolean }>(`${questionSelect('app.is_question_hidden(q.id) AS hidden,')} WHERE q.id = $1`, [id])).rows[0];
      if (!question) return null;
      const answers = (await q.query<{ id: string; body: string; answerer: string; answerer_id: string; created_at: Date; helpful: boolean; hidden: boolean }>(
        `SELECT a.id::text AS id, a.body, p.handle AS answerer, a.answerer_id, a.created_at, app.is_answer_hidden(a.id) AS hidden,
                EXISTS (SELECT 1 FROM app.helpful_marks h WHERE h.answer_id = a.id) AS helpful
         FROM app.answers a JOIN app.profiles p ON p.id = a.answerer_id
         WHERE a.question_id = $1 ORDER BY a.created_at, a.id`, [id])).rows;
      const selection = (await q.query<{ answer_id: string | null; changes: number; correct: boolean | null; stars: number | null }>(
        `SELECT s.answer_id::text AS answer_id, s.changes, v.correct, r.stars
         FROM app.selections s LEFT JOIN app.verdicts v ON v.answer_id = s.answer_id
         LEFT JOIN app.ratings r ON r.answer_id = s.answer_id
         WHERE s.question_id = $1`, [id])).rows[0] ?? null;
      // Each author's standing in this question's field: public on their
      // profile already; here it's who they are as a source on this question.
      const credibility = new Map<string, { reputation: number; accepted: number; medal: string | null; trust: number }>();
      for (const authorId of new Set(answers.map(a => a.answerer_id))) {
        const s = await standing(q, authorId);
        const inField = s.points.find(p => p.field.slug === question.field);
        credibility.set(authorId, {
          reputation: inField?.reputation ?? 0,
          accepted: inField?.accepted ?? 0,
          medal: inField?.medal ?? null,
          trust: s.trust ? s.trust.correct / s.trust.askers : NEUTRAL_TRUST,
        });
      }
      // How far it went (the asker only, numbers only), and why it reached
      // this viewer (that person only): the database gives each to no one else.
      const routing = (await q.query<{ waves: number; asked: number | null; in_country: number | null }>(
        'SELECT waves, asked, in_country FROM app.routing_summary($1)', [id])).rows[0];
      const why = viewer ? (await q.query<{ same_country: boolean | null; field_points: number | null; trust_pct: number | null; answered_pct: number | null; newcomer: boolean | null }>(
        'SELECT same_country, field_points, trust_pct, answered_pct, newcomer FROM app.routes WHERE question_id = $1 AND profile_id = $2', [id, viewer])).rows[0] : undefined;
      return { question, answers, selection, routing, why, credibility };
    });
    if (!found) return fail(reply, 404, 'not_found', 'This question doesn’t exist. It may have been deleted.');

    // Bible §11.4: what the answers report, how far they agree, and the
    // strongest answer of every smaller group pinned so it isn't buried.
    // Hidden answers don't count.
    const pickedId = found.selection?.answer_id ?? null;
    const claimed = new Map<string, Amount>();
    for (const a of found.answers) {
      const amount = a.hidden ? null : reportedAmount(a.body);
      if (amount) claimed.set(a.id, amount);
    }
    const cred = (authorId: string) => found.credibility.get(authorId) ?? { reputation: 0, accepted: 0, medal: null, trust: NEUTRAL_TRUST };
    const claims: Claim[] = found.answers.flatMap(a => {
      const amount = claimed.get(a.id);
      return amount ? [{ answerId: a.id, amount, reputation: cred(a.answerer_id).reputation / 100, trust: cred(a.answerer_id).trust }] : [];
    });
    const agreement = claims.length >= CONSENSUS_MIN ? consensus(claims) : null;
    const massOf = new Map(agreement?.clusters.flatMap(c => c.answerIds.map(id => [id, c.mass] as const)) ?? []);
    const pinned = new Set(agreement?.minorityPinned ?? []);
    // Bible §11.5: answers in order of Ω. The pick and helpful marks are the
    // asker's votes (one evaluation each), so Wilson is of that one vote.
    const ranked = found.answers.map(a => ({
      a,
      rank: answerRank({
        best: a.id === pickedId,
        wilson: wilsonLowerBound(a.helpful || a.id === pickedId ? 1 : 0, 1),
        reputation: cred(a.answerer_id).reputation / 100,
        clusterMass: massOf.get(a.id) ?? 0,
        trust: cred(a.answerer_id).trust,
        specificity: specificity(a.body),
      }),
    })).sort((x, y) => y.rank - x.rank || x.a.created_at.getTime() - y.a.created_at.getTime());
    return {
      // Hidden posts reach only their author and moderators; it says so for them.
      question: { ...summary(found.question), body: found.question.body, hidden: found.question.hidden },
      answers: ranked.map(({ a, rank }) => ({
        id: a.id, body: a.body, answerer: { handle: a.answerer }, createdAt: a.created_at.toISOString(), helpful: a.helpful, hidden: a.hidden,
        // Who they are as a source here: their standing in this field.
        author: { reputation: cred(a.answerer_id).reputation, accepted: cred(a.answerer_id).accepted, medal: cred(a.answerer_id).medal },
        claim: claimed.get(a.id) ?? null,
        minorityPinned: pinned.has(a.id),
        rank: Math.round(rank * 1000) / 1000,
      })),
      // Once 3 answers report an amount: the groups, largest first, and how
      // far they agree (1 = all agree). Shares are trust-weighted, not headcounts.
      consensus: agreement && {
        confidence: Math.round(agreement.confidence * 100) / 100,
        clusters: agreement.clusters.map(c => ({ currency: c.currency, lowMinor: c.lowMinor, highMinor: c.highMinor, share: Math.round(c.mass * 1000) / 1000, answers: c.answerIds.length })),
      },
      // The answer the asker picked, how many changes they have left, and
      // whether they said it turned out right (null: not said yet).
      selection: found.selection && {
        answerId: found.selection.answer_id,
        changesLeft: MAX_CHANGES - found.selection.changes,
        correct: found.selection.correct,
        stars: found.selection.stars,
      },
      // Only for the asker, once it went out: how many waves, how many people,
      // how many in the question's country. Under 5 is null ("a few"). Never who.
      ...(found.routing && {
        routing: { waves: found.routing.waves, asked: found.routing.asked, inCountry: found.routing.in_country },
      }),
      // Only for someone it was put to. Null parts: nothing to go on then,
      // or a route from before reasons were kept.
      ...(found.why && {
        whyYou: {
          sameCountry: found.why.same_country,
          fieldPoints: found.why.field_points,
          trustPct: found.why.trust_pct,
          answeredPct: found.why.answered_pct,
          newcomer: found.why.newcomer,
        },
      }),
    };
  });

  // Questions put to you, newest first, and how many you haven't opened.
  app.get('/me/inbox', { config: { auth: 'required' } }, async req => {
    const user = signedIn(req);
    const rows = await db.withUser(user.id, async q => (await q.query<QuestionRow & { routed_at: Date; seen: boolean }>(
      `${questionSelect('r.routed_at, r.seen_at IS NOT NULL AS seen,')}
       JOIN app.routes r ON r.question_id = q.id AND r.profile_id = $1
       ORDER BY r.routed_at DESC LIMIT 30`,
      [user.id])).rows);
    return {
      questions: rows.map(r => ({ ...summary(r), routedAt: r.routed_at.toISOString(), seen: r.seen })),
      unseen: rows.filter(r => !r.seen).length,
    };
  });

  app.post('/questions', {
    bodyLimit: WRITE_BODY_BYTES,
    config: { auth: 'required', write: true },
    schema: {
      body: {
        type: 'object', additionalProperties: false, required: ['title', 'field'],
        properties: {
          // Generous caps on the raw text; the real limits apply after tidying.
          title: { type: 'string', maxLength: 600 },
          details: { type: 'string', maxLength: 12_000 },
          field: fieldSchema,
          country: { anyOf: [countrySchema, { type: 'null' }] },
        },
      },
    },
  }, async (req, reply) => {
    const user = signedIn(req);
    const body = req.body as { title: string; details?: string; field: string; country?: string | null };
    const title = cleanLine(body.title);
    const details = cleanBody(body.details ?? '');
    const titleProblem = textProblem(title, LIMITS.title.min, LIMITS.title.max);
    if (titleProblem) return refuseText(reply, 'title', titleProblem);
    const detailsProblem = textProblem(details, LIMITS.details.min, LIMITS.details.max);
    if (detailsProblem) return refuseText(reply, 'details', detailsProblem);
    // Its meaning, for finding it again (a missed one is filled in later by the background job).
    const vector = await embed(questionText(title, details));
    let id: string | null;
    try {
      id = await db.withUser(user.id, async q => {
        if (await isBlocked(q)) return null;
        return inserted((await q.query<{ id: string }>(
          `INSERT INTO app.questions (asker_id, field, country, title, body, embedding, embedding_model)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id::text AS id`,
          [user.id, body.field, body.country ?? null, title, details, vector ? vectorLiteral(vector) : null, vector && embedder ? embedder.model : null])).rows);
      });
    } catch (err) {
      if (isNewAccountLimit(err)) return fail(reply, 429, 'new_account_limit', newAccountMessage);
      if (pgCode(err) === '23503' && pgConstraint(err) === 'questions_asker_id_fkey') {
        return fail(reply, 403, 'no_profile', 'Set up your profile before asking.');
      }
      if (pgCode(err) === '23503') return fail(reply, 400, 'invalid_request', 'Choose a field and country from the lists.');
      throw err;
    }
    if (id === null) return fail(reply, 403, 'blocked', blockedMessage);
    // Put it to people now, rather than at the routing job's next run.
    events.asked(id);
    return reply.code(201).send({ question: { id } });
  });

  app.post('/questions/:id/answers', {
    bodyLimit: WRITE_BODY_BYTES,
    config: { auth: 'required', write: true },
    schema: {
      params: { type: 'object', properties: { id: idSchema }, required: ['id'] },
      body: {
        type: 'object', additionalProperties: false, required: ['body'],
        properties: { body: { type: 'string', maxLength: 24_000 } },
      },
    },
  }, async (req, reply) => {
    const user = signedIn(req);
    const { id } = req.params as { id: string };
    const text = cleanBody((req.body as { body: string }).body);
    const problem = textProblem(text, LIMITS.answer.min, LIMITS.answer.max);
    if (problem) return refuseText(reply, 'answer', problem);
    let outcome: { kind: 'missing' } | { kind: 'own' } | { kind: 'blocked' } | { kind: 'ok'; id: string; askerId: string };
    try {
      outcome = await db.withUser(user.id, async q => {
        if (await isBlocked(q)) return { kind: 'blocked' as const };
        const question = (await q.query<{ asker_id: string }>('SELECT asker_id FROM app.questions WHERE id = $1', [id])).rows[0];
        if (!question) return { kind: 'missing' as const };
        if (question.asker_id === user.id) return { kind: 'own' as const };
        const answerId = inserted((await q.query<{ id: string }>(
          'INSERT INTO app.answers (question_id, answerer_id, body) VALUES ($1, $2, $3) RETURNING id::text AS id',
          [id, user.id, text])).rows);
        return { kind: 'ok' as const, id: answerId, askerId: question.asker_id };
      });
    } catch (err) {
      if (isNewAccountLimit(err)) return fail(reply, 429, 'new_account_limit', newAccountMessage);
      if (pgCode(err) === '23505' && pgConstraint(err) === 'answers_question_id_answerer_id_key') {
        return fail(reply, 409, 'already_answered', 'You’ve already answered this question.');
      }
      if (pgCode(err) === '23503' && pgConstraint(err) === 'answers_answerer_id_fkey') {
        return fail(reply, 403, 'no_profile', 'Set up your profile before answering.');
      }
      throw err;
    }
    if (outcome.kind === 'blocked') return fail(reply, 403, 'blocked', blockedMessage);
    if (outcome.kind === 'missing') return fail(reply, 404, 'not_found', 'This question doesn’t exist. It may have been deleted.');
    if (outcome.kind === 'own') return fail(reply, 409, 'own_question', 'You can’t answer your own question.');
    events.publish(outcome.askerId, { type: 'answered', questionId: id });
    return reply.code(201).send({ answer: { id: outcome.id } });
  });
}
