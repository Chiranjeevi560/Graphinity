// Reporting posts, and the owner's review: keep or remove reported posts,
// block or unblock people, and see pairs exchanging points from the same
// network. The database decides who may do what (db/migrations); this code
// explains refusals in plain words.
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Database, Queryable } from '../db.ts';
import { handleProblem, normalizeHandle } from '../handles.ts';
import { cleanBody, textProblem } from '../text.ts';
import { fail, pgCode, signedIn } from './common.ts';

export const REPORT_REASONS = ['spam', 'abuse', 'private_info', 'misleading', 'other'] as const;
const idSchema = { type: 'string', pattern: '^[1-9][0-9]{0,15}$' };

const reportBody = {
  type: 'object',
  additionalProperties: false,
  required: ['reason'],
  properties: { reason: { enum: [...REPORT_REASONS] }, note: { type: 'string', maxLength: 1000 } },
};

export async function isModerator(q: Queryable): Promise<boolean> {
  return (await q.query<{ ok: boolean }>('SELECT app.is_moderator() AS ok')).rows[0]?.ok === true;
}

export async function isBlocked(q: Queryable): Promise<boolean> {
  return (await q.query<{ ok: boolean }>('SELECT app.is_blocked() AS ok')).rows[0]?.ok === true;
}

export const blockedMessage = 'Your account can’t post right now. If you think this is a mistake, contact us.';

export function registerModerationRoutes(app: FastifyInstance, { db }: { db: Database }) {
  for (const kind of ['question', 'answer'] as const) {
    app.post(
      `/${kind}s/:id/report`,
      {
        config: { auth: 'required', write: true },
        schema: { params: { type: 'object', properties: { id: idSchema }, required: ['id'] }, body: reportBody },
      },
      async (req, reply) => {
        const user = signedIn(req);
        const { id } = req.params as { id: string };
        const body = req.body as { reason: string; note?: string };
        const note = cleanBody(body.note ?? '');
        if (textProblem(note, 0, 500))
          return fail(reply, 400, 'invalid_note', 'Keep the note under 500 characters, in plain text.');
        const table = kind === 'question' ? 'questions' : 'answers';
        const authorColumn = kind === 'question' ? 'asker_id' : 'answerer_id';
        const outcome = await db.withUser(user.id, async q => {
          if (await isBlocked(q)) return 'blocked' as const;
          const target = (
            await q.query<{ author: string }>(`SELECT ${authorColumn} AS author FROM app.${table} WHERE id = $1`, [id])
          ).rows[0];
          if (!target) return 'missing' as const;
          if (target.author === user.id) return 'own' as const;
          try {
            await q.query('SAVEPOINT report');
            await q.query(`INSERT INTO app.reports (reporter_id, ${kind}_id, reason, note) VALUES ($1, $2, $3, $4)`, [
              user.id,
              id,
              body.reason,
              note,
            ]);
            return 'ok' as const;
          } catch (err) {
            await q.query('ROLLBACK TO SAVEPOINT report');
            if (pgCode(err) === '23505') return 'again' as const;
            throw err;
          }
        });
        switch (outcome) {
          case 'blocked':
            return fail(reply, 403, 'blocked', blockedMessage);
          case 'missing':
            return fail(reply, 404, 'not_found', 'This doesn’t exist any more.');
          case 'own':
            return fail(reply, 400, 'own_post', 'You can’t report your own post.');
          // Already reported: say it's done, the same as the first time.
          case 'again':
          case 'ok':
            return reply.code(201).send({ report: { received: true } });
        }
      },
    );
  }

  // Everything below is for moderators only.
  async function asModerator<T>(
    userId: string,
    reply: FastifyReply,
    work: (q: Queryable) => Promise<T>,
  ): Promise<T | FastifyReply> {
    const result = await db.withUser(userId, async q =>
      (await isModerator(q)) ? { ok: true as const, value: await work(q) } : { ok: false as const },
    );
    return result.ok ? result.value : fail(reply, 403, 'not_a_moderator', 'This page is for moderators.');
  }

  app.get('/review', { config: { auth: 'required' } }, async (req, reply) => {
    const user = signedIn(req);
    return asModerator(user.id, reply, async q => {
      // Posts with reports since the last decision about them, newest first.
      const items = (
        await q.query<{
          kind: 'question' | 'answer';
          id: string;
          question_id: string;
          text: string;
          author: string;
          reports: number;
          reasons: string[];
          notes: string[] | null;
          hidden: boolean;
          last: Date;
        }>(`
        SELECT * FROM (
          SELECT 'question' AS kind, q.id::text AS id, q.id::text AS question_id, q.title AS text, p.handle AS author,
                 count(*)::int AS reports, array_agg(DISTINCT r.reason) AS reasons,
                 (array_agg(r.note ORDER BY r.created_at DESC) FILTER (WHERE r.note <> ''))[1:5] AS notes,
                 app.is_question_hidden(q.id) AS hidden, max(r.created_at) AS last
          FROM app.questions q JOIN app.profiles p ON p.id = q.asker_id
          JOIN app.reports r ON r.question_id = q.id
            AND r.created_at > coalesce((SELECT max(d.decided_at) FROM app.decisions d WHERE d.question_id = q.id), '-infinity')
          GROUP BY q.id, p.handle
          UNION ALL
          SELECT 'answer', a.id::text, a.question_id::text, a.body, p.handle,
                 count(*)::int, array_agg(DISTINCT r.reason),
                 (array_agg(r.note ORDER BY r.created_at DESC) FILTER (WHERE r.note <> ''))[1:5],
                 app.is_answer_hidden(a.id), max(r.created_at)
          FROM app.answers a JOIN app.profiles p ON p.id = a.answerer_id
          JOIN app.reports r ON r.answer_id = a.id
            AND r.created_at > coalesce((SELECT max(d.decided_at) FROM app.decisions d WHERE d.answer_id = a.id), '-infinity')
          GROUP BY a.id, p.handle
        ) open ORDER BY last DESC LIMIT 50`)
      ).rows;
      // People giving each other points from a shared network in the last 30 days.
      const pairs = (
        await q.query<{ giver: string; recipient: string; points: number }>(`
        SELECT gp.handle AS giver, rp.handle AS recipient, sum(l.amount)::int AS points
        FROM app.points_ledger l
        JOIN app.profiles gp ON gp.id = l.giver_id
        JOIN app.profiles rp ON rp.id = l.recipient_id
        WHERE l.created_at > now() - interval '30 days' AND l.amount > 0
          AND EXISTS (
            SELECT 1 FROM app.network_marks n1 JOIN app.network_marks n2 ON n2.network_hash = n1.network_hash
            WHERE n1.profile_id = l.giver_id AND n2.profile_id = l.recipient_id)
        GROUP BY gp.handle, rp.handle
        ORDER BY points DESC LIMIT 50`)
      ).rows;
      return {
        items: items.map(i => ({
          kind: i.kind,
          id: i.id,
          questionId: i.question_id,
          text: i.text,
          author: { handle: i.author },
          reports: i.reports,
          reasons: i.reasons,
          notes: i.notes ?? [],
          hidden: i.hidden,
          lastReportAt: i.last.toISOString(),
        })),
        sharedNetworks: pairs,
      };
    });
  });

  app.post(
    '/review/decision',
    {
      config: { auth: 'required', write: true },
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['kind', 'id', 'decision'],
          properties: { kind: { enum: ['question', 'answer'] }, id: idSchema, decision: { enum: ['keep', 'remove'] } },
        },
      },
    },
    async (req, reply) => {
      const user = signedIn(req);
      const { kind, id, decision } = req.body as {
        kind: 'question' | 'answer';
        id: string;
        decision: 'keep' | 'remove';
      };
      try {
        return await asModerator(user.id, reply, async q => {
          await q.query(`INSERT INTO app.decisions (${kind}_id, decision, decided_by) VALUES ($1, $2, $3)`, [
            id,
            decision,
            user.id,
          ]);
          return { decision: { kind, id, decision } };
        });
      } catch (err) {
        // Deleted while the review page was open (with its author's account).
        if (pgCode(err) === '23503') return fail(reply, 404, 'not_found', 'This post doesn’t exist any more.');
        throw err;
      }
    },
  );

  const blockBody = {
    type: 'object',
    additionalProperties: false,
    required: ['handle'],
    properties: { handle: { type: 'string', maxLength: 64 }, reason: { type: 'string', maxLength: 500 } },
  };

  app.post(
    '/review/block',
    { config: { auth: 'required', write: true }, schema: { body: blockBody } },
    async (req, reply) => {
      const user = signedIn(req);
      const body = req.body as { handle: string; reason?: string };
      const handle = normalizeHandle(body.handle);
      if (handleProblem(handle)) return fail(reply, 404, 'not_found', 'There’s no one with that name.');
      const reason = cleanBody(body.reason ?? '');
      if (textProblem(reason, 0, 500))
        return fail(reply, 400, 'invalid_reason', 'Keep the reason under 500 characters, in plain text.');
      return asModerator(user.id, reply, async q => {
        const person = (await q.query<{ id: string }>('SELECT id FROM app.profiles WHERE handle = $1', [handle]))
          .rows[0];
        if (!person) return fail(reply, 404, 'not_found', 'There’s no one with that name.');
        if (person.id === user.id) return fail(reply, 400, 'not_yourself', 'You can’t block yourself.');
        const added = await q.query(
          'INSERT INTO app.blocks (profile_id) VALUES ($1) ON CONFLICT (profile_id) DO NOTHING',
          [person.id],
        );
        // Who blocked and why: for moderators only, never shown to the blocked person.
        if (added.rowCount) {
          await q.query('INSERT INTO app.block_details (profile_id, blocked_by, reason) VALUES ($1, $2, $3)', [
            person.id,
            user.id,
            reason,
          ]);
        }
        return { block: { handle, blocked: true } };
      });
    },
  );

  app.delete(
    '/review/block',
    { config: { auth: 'required', write: true }, schema: { body: blockBody } },
    async (req, reply) => {
      const user = signedIn(req);
      const handle = normalizeHandle((req.body as { handle: string }).handle);
      return asModerator(user.id, reply, async q => {
        await q.query('DELETE FROM app.blocks b USING app.profiles p WHERE b.profile_id = p.id AND p.handle = $1', [
          handle,
        ]);
        return { block: { handle, blocked: false } };
      });
    },
  );
}
