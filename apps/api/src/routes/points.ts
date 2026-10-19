// Picking the answer that helped, marking others helpful, and saying later
// whether the pick turned out right. Points move inside the database
// (db/schema.sql: triggers on selections and helpful_marks), which also
// enforces the pair cap and refuses any points that didn't happen. This
// code checks each rule first only to explain refusals in plain words.
import type { FastifyInstance } from 'fastify';
import type { Database, Queryable } from '../db.ts';
import { displayedReputation, medalFor, replay, wilsonLowerBound } from '../reputation.ts';
import { fail, pgCode, signedIn } from './common.ts';

export const MAX_CHANGES = 2;
export const CHANGE_REASONS = ['turned_out_wrong', 'better_answer_later', 'picked_by_mistake'] as const;
/** A picked answer rated this many stars or fewer counts against its author. */
export const LOW_RATING = 2;
/** Gold needs the top 1% of people active in the field (and country) in this window. */
const ACTIVE_WINDOW = '90 days';
/** Trust is shown once this many different askers have said how it turned out. */
export const TRUST_MIN_ASKERS = 3;

const idSchema = { type: 'string', pattern: '^[1-9][0-9]{0,15}$' };
const idParams = { type: 'object', properties: { id: idSchema }, required: ['id'] };

/**
 * A person's standing, field by field, as docs/SPEC.md §11.3
 * defines it, plus points and trust: what anyone may see.
 *
 * Reputation is TrueSkill replayed from every judgement on their answers in
 * that field, in time order: a pick or a helpful mark that still stands
 * (the ledger already applies the pair cap and take-backs) is a win, unless
 * the pick was rated 2 stars or less; an asker saying it turned out right is
 * a win, wrong a loss. Recomputed from the record each time, so a changed
 * pick can never leave stale credit behind.
 */
/**
 * Every judgement on these people's answers, oldest first, per person and
 * field (in one field, when given): the games TrueSkill replays (spec §11.3).
 * A pick wins unless the asker rated it low; a helpful mark wins; a verdict
 * wins when it turned out right.
 */
export async function judgements(
  q: Queryable,
  people: readonly string[],
  field: string | null,
): Promise<Map<string, Map<string, boolean[]>>> {
  const rows = (
    await q.query<{ person: string; field: string; won: boolean }>(
      `SELECT person, field, won FROM (
       SELECT l.recipient_id AS person, l.field, l.created_at AS at, l.id AS tie,
              NOT (l.reason = 'selected' AND coalesce((SELECT r.stars FROM app.ratings r WHERE r.answer_id = l.answer_id), 5) <= $2) AS won
       FROM app.points_ledger l
       WHERE l.recipient_id = ANY ($1::uuid[]) AND l.reason IN ('selected', 'helpful') AND l.amount > 0
         AND ($3::text IS NULL OR l.field = $3)
         AND NOT EXISTS (SELECT 1 FROM app.points_ledger x WHERE x.reverses = l.id)
       UNION ALL
       SELECT a.answerer_id, jq.field, v.at, v.answer_id, v.correct
       FROM app.verdicts v JOIN app.answers a ON a.id = v.answer_id JOIN app.questions jq ON jq.id = a.question_id
       WHERE a.answerer_id = ANY ($1::uuid[]) AND ($3::text IS NULL OR jq.field = $3)
     ) e ORDER BY at, tie`,
      [people, LOW_RATING, field],
    )
  ).rows;
  const out = new Map<string, Map<string, boolean[]>>();
  for (const r of rows) {
    const byField = out.get(r.person) ?? new Map<string, boolean[]>();
    byField.set(r.field, [...(byField.get(r.field) ?? []), r.won]);
    out.set(r.person, byField);
  }
  return out;
}

export async function standing(q: Queryable, profileId: string) {
  const points = (
    await q.query<{
      slug: string;
      name: string;
      points: number;
      accepted: number;
      answers: number;
      helped: number;
      country: string | null;
    }>(
      `SELECT l.field AS slug, f.name, sum(l.amount)::int AS points,
            count(*) FILTER (WHERE l.reason = 'selected' AND l.amount > 0
              AND NOT EXISTS (SELECT 1 FROM app.points_ledger x WHERE x.reverses = l.id))::int AS accepted,
            (SELECT count(*) FROM app.answers a JOIN app.questions aq ON aq.id = a.question_id
             WHERE a.answerer_id = $1 AND aq.field = l.field)::int AS answers,
            (SELECT count(DISTINCT h.answer_id) FROM app.points_ledger h
             WHERE h.recipient_id = $1 AND h.field = l.field AND h.amount > 0 AND h.reason IN ('selected', 'helpful')
               AND NOT EXISTS (SELECT 1 FROM app.points_ledger x WHERE x.reverses = h.id))::int AS helped,
            (SELECT p.country FROM app.profiles p WHERE p.id = $1) AS country
     FROM app.points_ledger l JOIN app.fields f ON f.slug = l.field
     WHERE l.recipient_id = $1
     GROUP BY l.field, f.name, f.position
     HAVING sum(l.amount) > 0
     ORDER BY sum(l.amount) DESC, f.position`,
      [profileId],
    )
  ).rows;
  const outcomes = (await judgements(q, [profileId], null)).get(profileId) ?? new Map<string, boolean[]>();
  // Each asker counts once: their latest word on this person's picked answers.
  const trust = (
    await q.query<{ correct: number; total: number }>(
      `SELECT count(*) FILTER (WHERE correct)::int AS correct, count(*)::int AS total
     FROM (
       SELECT DISTINCT ON (q.asker_id) v.correct
       FROM app.verdicts v
       JOIN app.answers a ON a.id = v.answer_id
       JOIN app.questions q ON q.id = a.question_id
       WHERE a.answerer_id = $1
       ORDER BY q.asker_id, v.at DESC
     ) latest`,
      [profileId],
    )
  ).rows[0];
  const fields = await Promise.all(
    points.map(async p => {
      const reputation = displayedReputation(replay(outcomes.get(p.slug) ?? []));
      const wilson = wilsonLowerBound(p.helped, p.answers);
      // Gold needs the top 1% of people active in this field and country:
      // asked only when every other bar is already met, which is rare.
      const topPercent =
        p.accepted >= 75 && reputation >= 85 && (await isTopPercent(q, profileId, p.slug, p.country, p.accepted));
      return {
        field: { slug: p.slug, name: p.name },
        points: p.points,
        medal: medalFor({ accepted: p.accepted, reputation, wilson, topPercent }),
        // Spec §11.3: 0 to 100, one decimal; how many picks; Wilson of helped/answered.
        reputation: Math.round(reputation * 10) / 10,
        accepted: p.accepted,
        wilson: Math.round(wilson * 100) / 100,
      };
    }),
  );
  return {
    points: fields,
    trust: trust && trust.total >= TRUST_MIN_ASKERS ? { correct: trust.correct, askers: trust.total } : null,
  };
}

/** In the top 1% of people active in the field and country, by accepted answers. */
async function isTopPercent(
  q: Queryable,
  profileId: string,
  field: string,
  country: string | null,
  accepted: number,
): Promise<boolean> {
  const row = (
    await q.query<{ active: number; ahead: number }>(
      `WITH active AS (
       SELECT a.answerer_id AS id FROM app.answers a
       JOIN app.questions aq ON aq.id = a.question_id
       JOIN app.profiles p ON p.id = a.answerer_id
       WHERE aq.field = $1 AND p.country IS NOT DISTINCT FROM $2 AND a.created_at > now() - interval '${ACTIVE_WINDOW}'
       GROUP BY a.answerer_id
     ), scores AS (
       SELECT active.id, (SELECT count(*) FROM app.points_ledger l
         WHERE l.recipient_id = active.id AND l.field = $1 AND l.reason = 'selected' AND l.amount > 0
           AND NOT EXISTS (SELECT 1 FROM app.points_ledger x WHERE x.reverses = l.id)) AS accepted
       FROM active
     )
     SELECT count(*)::int AS active, count(*) FILTER (WHERE accepted > $3 AND id <> $4)::int AS ahead FROM scores`,
      [field, country, accepted, profileId],
    )
  ).rows[0];
  return row !== undefined && row.active > 0 && row.ahead < Math.max(1, row.active * 0.01);
}

export function registerPointRoutes(app: FastifyInstance, { db }: { db: Database }) {
  app.put(
    '/questions/:id/selection',
    {
      config: { auth: 'required', write: true },
      schema: {
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['answerId'],
          properties: { answerId: idSchema, reason: { enum: [...CHANGE_REASONS] } },
        },
      },
    },
    async (req, reply) => {
      const user = signedIn(req);
      const { id } = req.params as { id: string };
      const { answerId, reason } = req.body as { answerId: string; reason?: (typeof CHANGE_REASONS)[number] };
      type Outcome =
        | { kind: 'missing' | 'not_yours' | 'not_an_answer' | 'reason_required' | 'no_changes_left' }
        | { kind: 'ok'; changes: number };
      let outcome: Outcome;
      try {
        outcome = await db.withUser(user.id, async (q): Promise<Outcome> => {
          const question = (
            await q.query<{ asker_id: string }>('SELECT asker_id FROM app.questions WHERE id = $1', [id])
          ).rows[0];
          if (!question) return { kind: 'missing' };
          if (question.asker_id !== user.id) return { kind: 'not_yours' };
          const onQuestion = (
            await q.query('SELECT 1 FROM app.answers WHERE id = $1 AND question_id = $2', [answerId, id])
          ).rowCount;
          if (!onQuestion) return { kind: 'not_an_answer' };
          // A first pick; if another request's first pick wins the race, this
          // one carries on as a change of that pick.
          const first = await q.query(
            'INSERT INTO app.selections (question_id, answer_id) VALUES ($1, $2) ON CONFLICT (question_id) DO NOTHING',
            [id, answerId],
          );
          if (first.rowCount) return { kind: 'ok', changes: 0 };
          // Lock the pick so two changes at once can't both pass the checks.
          const current = (
            await q.query<{ answer_id: string | null; changes: number }>(
              'SELECT answer_id::text AS answer_id, changes FROM app.selections WHERE question_id = $1 FOR UPDATE',
              [id],
            )
          ).rows[0];
          if (!current) throw new Error('selection vanished after a conflicting insert');
          if (current.answer_id === answerId) return { kind: 'ok', changes: current.changes };
          // The old pick was deleted with its author's account: picking again is free.
          if (current.answer_id === null) {
            await q.query('UPDATE app.selections SET answer_id = $2 WHERE question_id = $1', [id, answerId]);
            return { kind: 'ok', changes: current.changes };
          }
          if (!reason) return { kind: 'reason_required' };
          if (current.changes >= MAX_CHANGES) return { kind: 'no_changes_left' };
          // With "turned_out_wrong" the database also records the asker's
          // verdict on the old pick (db/schema.sql, check_selection).
          await q.query('UPDATE app.selections SET answer_id = $2, change_reason = $3 WHERE question_id = $1', [
            id,
            answerId,
            reason,
          ]);
          return { kind: 'ok', changes: current.changes + 1 };
        });
      } catch (err) {
        // The database's own checks: a change past the limit raced in.
        if (pgCode(err) === '23514' && (err as Error).message === 'the pick was already changed twice') {
          return fail(reply, 409, 'no_changes_left', 'You’ve already changed your pick twice for this question.');
        }
        throw err;
      }
      switch (outcome.kind) {
        case 'missing':
          return fail(reply, 404, 'not_found', 'This question doesn’t exist. It may have been deleted.');
        case 'not_yours':
          return fail(reply, 403, 'not_your_question', 'Only the person who asked can pick the answer that helped.');
        case 'not_an_answer':
          return fail(reply, 400, 'not_an_answer', 'That answer isn’t on this question.');
        case 'reason_required':
          return fail(reply, 400, 'reason_required', 'Say why you’re changing your pick.');
        case 'no_changes_left':
          return fail(reply, 409, 'no_changes_left', 'You’ve already changed your pick twice for this question.');
        case 'ok':
          return { selection: { answerId, changesLeft: MAX_CHANGES - outcome.changes } };
      }
    },
  );

  app.post(
    '/answers/:id/helpful',
    {
      config: { auth: 'required', write: true },
      schema: { params: idParams },
    },
    async (req, reply) => {
      const user = signedIn(req);
      const { id } = req.params as { id: string };
      const outcome = await db.withUser(user.id, async q => {
        const row = (
          await q.query<{ asker_id: string }>(
            'SELECT q.asker_id FROM app.answers a JOIN app.questions q ON q.id = a.question_id WHERE a.id = $1',
            [id],
          )
        ).rows[0];
        if (!row) return 'missing' as const;
        if (row.asker_id !== user.id) return 'not_yours' as const;
        await q.query('INSERT INTO app.helpful_marks (answer_id) VALUES ($1) ON CONFLICT (answer_id) DO NOTHING', [id]);
        return 'ok' as const;
      });
      if (outcome === 'missing')
        return fail(reply, 404, 'not_found', 'This answer doesn’t exist. It may have been deleted.');
      if (outcome === 'not_yours')
        return fail(reply, 403, 'not_your_question', 'Only the person who asked can mark answers helpful.');
      return { helpful: true };
    },
  );

  app.put(
    '/answers/:id/verdict',
    {
      config: { auth: 'required', write: true },
      schema: {
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['correct'],
          properties: { correct: { type: 'boolean' } },
        },
      },
    },
    async (req, reply) => {
      const user = signedIn(req);
      const { id } = req.params as { id: string };
      const { correct } = req.body as { correct: boolean };
      const outcome = await db.withUser(user.id, async q => {
        const row = (
          await q.query<{ asker_id: string; picked: boolean }>(
            `SELECT q.asker_id, EXISTS (SELECT 1 FROM app.selections s WHERE s.answer_id = a.id) AS picked
         FROM app.answers a JOIN app.questions q ON q.id = a.question_id WHERE a.id = $1`,
            [id],
          )
        ).rows[0];
        if (!row) return 'missing' as const;
        if (row.asker_id !== user.id) return 'not_yours' as const;
        if (!row.picked) return 'not_picked' as const;
        await q.query(
          'INSERT INTO app.verdicts (answer_id, correct) VALUES ($1, $2) ON CONFLICT (answer_id) DO UPDATE SET correct = EXCLUDED.correct',
          [id, correct],
        );
        return 'ok' as const;
      });
      if (outcome === 'missing')
        return fail(reply, 404, 'not_found', 'This answer doesn’t exist. It may have been deleted.');
      if (outcome === 'not_yours')
        return fail(reply, 403, 'not_your_question', 'Only the person who asked can say how it turned out.');
      if (outcome === 'not_picked')
        return fail(reply, 409, 'not_picked', 'Pick this answer first, then say how it turned out.');
      return { verdict: { correct } };
    },
  );

  // Spec §7.2 Screen 4: one tap after picking, how good the answer was.
  app.put(
    '/answers/:id/rating',
    {
      config: { auth: 'required', write: true },
      schema: {
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['stars'],
          properties: { stars: { type: 'integer', minimum: 1, maximum: 5 } },
        },
      },
    },
    async (req, reply) => {
      const user = signedIn(req);
      const { id } = req.params as { id: string };
      const { stars } = req.body as { stars: number };
      const outcome = await db.withUser(user.id, async q => {
        const row = (
          await q.query<{ asker_id: string; picked: boolean }>(
            `SELECT q.asker_id, EXISTS (SELECT 1 FROM app.selections s WHERE s.answer_id = a.id) AS picked
         FROM app.answers a JOIN app.questions q ON q.id = a.question_id WHERE a.id = $1`,
            [id],
          )
        ).rows[0];
        if (!row) return 'missing' as const;
        if (row.asker_id !== user.id) return 'not_yours' as const;
        if (!row.picked) return 'not_picked' as const;
        await q.query(
          'INSERT INTO app.ratings (answer_id, stars) VALUES ($1, $2) ON CONFLICT (answer_id) DO UPDATE SET stars = EXCLUDED.stars',
          [id, stars],
        );
        return 'ok' as const;
      });
      if (outcome === 'missing')
        return fail(reply, 404, 'not_found', 'This answer doesn’t exist. It may have been deleted.');
      if (outcome === 'not_yours')
        return fail(reply, 403, 'not_your_question', 'Only the person who asked can rate the answer they picked.');
      if (outcome === 'not_picked') return fail(reply, 409, 'not_picked', 'Pick this answer first, then rate it.');
      return { rating: { stars } };
    },
  );
}
