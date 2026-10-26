// Audiences for the people who run a business's advertising
// (docs/adr/0022-advertising-platform.md part 7): describe one, list them,
// remove one. Who is in an audience is never shown, only whether it is ready
// and its size rounded down to a hundred; under 100 people there is no number.
// The database decides who may do what (migration 0036).
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Database } from '../db.ts';
import { cleanLine } from '../text.ts';
import { shownSize } from '../ads/audiences.ts';
import { fail, pgCode, signedIn } from './common.ts';

const uuid = { type: 'string', format: 'uuid' };
const slug = { type: 'string', pattern: '^[a-z]+(-[a-z]+)*$', maxLength: 40 };
const condition = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['interest'],
      properties: { interest: slug, min: { type: 'number', exclusiveMinimum: 0, maximum: 1000 } },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['country'],
      properties: { country: { type: 'string', pattern: '^[A-Z]{2}$' } },
    },
    { type: 'object', additionalProperties: false, required: ['field'], properties: { field: slug } },
  ],
};
const conditions = (min: number) => ({ type: 'array', minItems: min, maxItems: 20, items: condition });

interface AudienceRow {
  public_id: string;
  name: string;
  kind: string;
  status: string;
  size: number;
  built_at: Date | null;
}
const out = (a: AudienceRow) => ({
  id: a.public_id,
  name: a.name,
  kind: a.kind,
  status: a.status,
  size: shownSize(a.size),
  builtAt: a.built_at?.toISOString() ?? null,
});

export function registerAdAudienceRoutes(
  app: FastifyInstance,
  { db, enabled }: { db: Database; enabled: () => boolean },
) {
  const off = (reply: FastifyReply) => fail(reply, 404, 'ads_off', 'Advertising on Graphinity isn’t available yet.');
  const missing = (reply: FastifyReply) => fail(reply, 404, 'not_found', 'There’s no such advertiser you run.');

  app.post(
    '/ads/advertisers/:id/audiences',
    {
      config: { auth: 'required', write: true },
      schema: {
        params: { type: 'object', properties: { id: uuid }, required: ['id'] },
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'kind'],
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 120 },
            kind: { enum: ['segment', 'retargeting', 'lookalike'] },
            rule: {
              type: 'object',
              additionalProperties: false,
              required: ['all'],
              properties: { all: conditions(1), any: conditions(0) },
            },
            campaignId: uuid,
            seedAudienceId: uuid,
            expansion: { enum: [0.01, 0.02, 0.05] },
          },
        },
      },
    },
    async (req, reply) => {
      if (!enabled()) return off(reply);
      const user = signedIn(req);
      const { id } = req.params as { id: string };
      const b = req.body as {
        name: string;
        kind: 'segment' | 'retargeting' | 'lookalike';
        rule?: object;
        campaignId?: string;
        seedAudienceId?: string;
        expansion?: number;
      };
      const name = cleanLine(b.name);
      const shapeOk =
        b.kind === 'segment'
          ? b.rule && !b.campaignId && !b.seedAudienceId && b.expansion === undefined
          : b.kind === 'retargeting'
            ? b.campaignId && !b.rule && !b.seedAudienceId && b.expansion === undefined
            : b.seedAudienceId && b.expansion !== undefined && !b.rule && !b.campaignId;
      if (!name || !shapeOk)
        return fail(
          reply,
          400,
          'invalid',
          'Give a name, and a rule for a segment, a campaign for reminders, or an audience and a size for look-alikes.',
        );
      let made: AudienceRow | 'missing' | 'off' | 'not_own' | 'too_many';
      try {
        made = await db.withUser(user.id, async q => {
          const advertiser = (
            await q.query<{ id: string }>('SELECT id::text FROM app.ad_advertisers WHERE public_id = $1', [id])
          ).rows[0];
          if (!advertiser) return 'missing' as const;
          const row = (
            await q.query<AudienceRow>(
              `INSERT INTO app.ad_audiences (advertiser_id, name, kind, rule, source_campaign_id, seed_audience_id, expansion)
               VALUES ($1, $2, $3, $4,
                       (SELECT c.id FROM app.ad_campaigns c WHERE c.public_id = $5),
                       (SELECT s.id FROM app.ad_audiences s WHERE s.public_id = $6), $7)
               RETURNING public_id::text, name, kind, status, size, built_at`,
              [
                advertiser.id,
                name,
                b.kind,
                b.rule === undefined ? null : JSON.stringify(b.rule),
                b.campaignId ?? null,
                b.seedAudienceId ?? null,
                b.expansion ?? null,
              ],
            )
          ).rows[0];
          return row ?? ('missing' as const);
        });
      } catch (err) {
        const code = pgCode(err);
        const message = (err as { message?: string }).message ?? '';
        if (code === '42501' && /own business/.test(message)) made = 'not_own';
        else if (code === '42501') made = 'off';
        else if (code === '23514' && /at most 50/.test(message)) made = 'too_many';
        // A campaign or seed id that names nothing of this business leaves its column empty.
        else if (code === '23514') made = 'not_own';
        else throw err;
      }
      if (made === 'missing') return missing(reply);
      if (made === 'off') return fail(reply, 403, 'not_allowed', 'Audiences aren’t available for this business.');
      if (made === 'not_own')
        return fail(reply, 400, 'not_own', 'Use one of your own business’s campaigns or audiences.');
      if (made === 'too_many') return fail(reply, 400, 'too_many_audiences', 'Remove an audience first: at most 50.');
      return reply.code(201).send({ audience: out(made) });
    },
  );

  app.get(
    '/ads/advertisers/:id/audiences',
    {
      config: { auth: 'required' },
      schema: { params: { type: 'object', properties: { id: uuid }, required: ['id'] } },
    },
    async (req, reply) => {
      if (!enabled()) return off(reply);
      const user = signedIn(req);
      const { id } = req.params as { id: string };
      const rows = await db.withUser(user.id, async q => {
        const advertiser = // Row-level security shows a business only to its own members.
          (await q.query<{ id: string }>('SELECT id::text FROM app.ad_advertisers WHERE public_id = $1', [id])).rows[0];
        if (!advertiser) return null;
        return (
          await q.query<AudienceRow>(
            `SELECT public_id::text, name, kind, status, size, built_at FROM app.ad_audiences
             WHERE advertiser_id = $1 ORDER BY id`,
            [advertiser.id],
          )
        ).rows;
      });
      if (!rows) return missing(reply);
      return { audiences: rows.map(out) };
    },
  );

  app.delete(
    '/ads/audiences/:id',
    {
      config: { auth: 'required', write: true },
      schema: { params: { type: 'object', properties: { id: uuid }, required: ['id'] } },
    },
    async (req, reply) => {
      if (!enabled()) return off(reply);
      const user = signedIn(req);
      const { id } = req.params as { id: string };
      const removed = await db.withUser(
        user.id,
        async q => (await q.query('DELETE FROM app.ad_audiences WHERE public_id = $1', [id])).rowCount ?? 0,
      );
      if (!removed) return fail(reply, 404, 'not_found', 'There’s no such audience you run.');
      return { removed: true };
    },
  );
}
