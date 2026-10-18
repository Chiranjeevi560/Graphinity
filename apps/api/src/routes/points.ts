// Picking the answer that helped, marking others helpful, and saying later
// whether the pick turned out right. Points move inside the database
// (db/schema.sql: triggers on selections and helpful_marks), which also
// enforces the pair cap and refuses any points that didn't happen. This
// code checks each rule first only to explain refusals in plain words.
import type { FastifyInstance } from 'fastify';
import type { Database, Queryable } from '../db.ts';
import { fail, pgCode, signedIn } from './common.ts';

export const MAX_CHANGES = 2;
export const CHANGE_REASONS = ['turned_out_wrong', 'better_answer_later', 'picked_by_mistake'] as const;
/** Points in one field for each medal. Highest first. */
export const MEDALS = [
  { medal: 'gold', min: 200 },
  { medal: 'silver', min: 50 },
  { medal: 'bronze', min: 10 },
] as const;
/** Trust is shown once this many different askers have said how it turned out. */
export const TRUST_MIN_ASKERS = 3;

const idSchema = { type: 'string', pattern: '^[1-9][0-9]{0,15}$' };
const idParams = { type: 'object', properties: { id: idSchema }, required: ['id'] };

/** Points per field, medals and trust: what anyone may see about a person's standing. */
export async function standing(q: Queryable, profileId: string) {
  const points = (await q.query<{ slug: string; name: string; points: number }>(
    `SELECT l.field AS slug, f.name, sum(l.amount)::int AS points
     FROM app.points_ledger l JOIN app.fields f ON f.slug = l.field
     WHERE l.recipient_id = $1
     GROUP BY l.field, f.name, f.position
     HAVING sum(l.amount) > 0
     ORDER BY sum(l.amount) DESC, f.position`, [profileId])).rows;
  // Each asker counts once: their latest word on this person's picked answers.
  const trust = (await q.query<{ correct: number; total: number }>(
    `SELECT count(*) FILTER (WHERE correct)::int AS correct, count(*)::int AS total
     FROM (
       SELECT DISTINCT ON (q.asker_id) v.correct
       FROM app.verdicts v
       JOIN app.answers a ON a.id = v.answer_id
       JOIN app.questions q ON q.id = a.question_id
       WHERE a.answerer_id = $1
       ORDER BY q.asker_id, v.at DESC
     ) latest`, [profileId])).rows[0];
  return {
    points: points.map(p => ({
      field: { slug: p.slug, name: p.name },
      points: p.points,
      medal: MEDALS.find(m => p.points >= m.min)?.medal ?? null,
    })),
    trust: trust && trust.total >= TRUST_MIN_ASKERS ? { correct: trust.correct, askers: trust.total } : null,
  };
}

export function registerPointRoutes(app: FastifyInstance, { db }: { db: Database }) {
  app.put('/questions/:id/selection', {
    config: { auth: 'required', write: true },
    schema: {
      params: idParams,
      body: {
        type: 'object', additionalProperties: false, required: ['answerId'],
        properties: { answerId: idSchema, reason: { enum: [...CHANGE_REASONS] } },
      },
    },
  }, async (req, reply) => {
    const user = signedIn(req);
    const { id } = req.params as { id: string };
    const { answerId, reason } = req.body as { answerId: string; reason?: (typeof CHANGE_REASONS)[number] };
    type Outcome =
      | { kind: 'missing' | 'not_yours' | 'not_an_answer' | 'reason_required' | 'no_changes_left' }
      | { kind: 'ok'; changes: number };
    let outcome: Outcome;
    try {
      outcome = await db.withUser(user.id, async (q): Promise<Outcome> => {
        const question = (await q.query<{ asker_id: string }>('SELECT asker_id FROM app.questions WHERE id = $1', [id])).rows[0];
        if (!question) return { kind: 'missing' };
        if (question.asker_id !== user.id) return { kind: 'not_yours' };
        const onQuestion = (await q.query('SELECT 1 FROM app.answers WHERE id = $1 AND question_id = $2', [answerId, id])).rowCount;
        if (!onQuestion) return { kind: 'not_an_answer' };
        // A first pick; if another request's first pick wins the race, this
        // one carries on as a change of that pick.
        const first = await q.query(
          'INSERT INTO app.selections (question_id, answer_id) VALUES ($1, $2) ON CONFLICT (question_id) DO NOTHING', [id, answerId]);
        if (first.rowCount) return { kind: 'ok', changes: 0 };
        // Lock the pick so two changes at once can't both pass the checks.
        const current = (await q.query<{ answer_id: string | null; changes: number }>(
          'SELECT answer_id::text AS answer_id, changes FROM app.selections WHERE question_id = $1 FOR UPDATE', [id])).rows[0];
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
        await q.query('UPDATE app.selections SET answer_id = $2, change_reason = $3 WHERE question_id = $1', [id, answerId, reason]);
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
      case 'missing': return fail(reply, 404, 'not_found', 'This question doesn’t exist. It may have been deleted.');
      case 'not_yours': return fail(reply, 403, 'not_your_question', 'Only the person who asked can pick the answer that helped.');
      case 'not_an_answer': return fail(reply, 400, 'not_an_answer', 'That answer isn’t on this question.');
      case 'reason_required': return fail(reply, 400, 'reason_required', 'Say why you’re changing your pick.');
      case 'no_changes_left': return fail(reply, 409, 'no_changes_left', 'You’ve already changed your pick twice for this question.');
      case 'ok': return { selection: { answerId, changesLeft: MAX_CHANGES - outcome.changes } };
    }
  });

  app.post('/answers/:id/helpful', {
    config: { auth: 'required', write: true },
    schema: { params: idParams },
  }, async (req, reply) => {
    const user = signedIn(req);
    const { id } = req.params as { id: string };
    const outcome = await db.withUser(user.id, async q => {
      const row = (await q.query<{ asker_id: string }>(
        'SELECT q.asker_id FROM app.answers a JOIN app.questions q ON q.id = a.question_id WHERE a.id = $1', [id])).rows[0];
      if (!row) return 'missing' as const;
      if (row.asker_id !== user.id) return 'not_yours' as const;
      await q.query('INSERT INTO app.helpful_marks (answer_id) VALUES ($1) ON CONFLICT (answer_id) DO NOTHING', [id]);
      return 'ok' as const;
    });
    if (outcome === 'missing') return fail(reply, 404, 'not_found', 'This answer doesn’t exist. It may have been deleted.');
    if (outcome === 'not_yours') return fail(reply, 403, 'not_your_question', 'Only the person who asked can mark answers helpful.');
    return { helpful: true };
  });

  app.put('/answers/:id/verdict', {
    config: { auth: 'required', write: true },
    schema: {
      params: idParams,
      body: { type: 'object', additionalProperties: false, required: ['correct'], properties: { correct: { type: 'boolean' } } },
    },
  }, async (req, reply) => {
    const user = signedIn(req);
    const { id } = req.params as { id: string };
    const { correct } = req.body as { correct: boolean };
    const outcome = await db.withUser(user.id, async q => {
      const row = (await q.query<{ asker_id: string; picked: boolean }>(
        `SELECT q.asker_id, EXISTS (SELECT 1 FROM app.selections s WHERE s.answer_id = a.id) AS picked
         FROM app.answers a JOIN app.questions q ON q.id = a.question_id WHERE a.id = $1`, [id])).rows[0];
      if (!row) return 'missing' as const;
      if (row.asker_id !== user.id) return 'not_yours' as const;
      if (!row.picked) return 'not_picked' as const;
      await q.query(
        'INSERT INTO app.verdicts (answer_id, correct) VALUES ($1, $2) ON CONFLICT (answer_id) DO UPDATE SET correct = EXCLUDED.correct',
        [id, correct]);
      return 'ok' as const;
    });
    if (outcome === 'missing') return fail(reply, 404, 'not_found', 'This answer doesn’t exist. It may have been deleted.');
    if (outcome === 'not_yours') return fail(reply, 403, 'not_your_question', 'Only the person who asked can say how it turned out.');
    if (outcome === 'not_picked') return fail(reply, 409, 'not_picked', 'Pick this answer first, then say how it turned out.');
    return { verdict: { correct } };
  });
}
