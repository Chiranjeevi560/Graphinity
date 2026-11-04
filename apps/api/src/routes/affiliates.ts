// Affiliate referrals (ADR 0036), off by default. Links are labelled and shown apart from answers; they never enter
// any ranking of knowledge (ADR 0003). The database repeats the rules (migration 0073): only the owner adds programs
// and links, only while the switch is on, and a link goes only to its program's host.
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Database, Queryable } from '../db.ts';
import { auditWithin } from '../platform/jobs.ts';
import { purposeKey } from '../rate-limit.ts';
import { fail, pgCode, signedIn } from './common.ts';

export const DISCLOSURE =
  'Affiliate link: Graphinity may earn a commission if you buy. It never changes which answers you see.';

/**
 * The key a network signs its sale reports with, different for each program; given once, never stored. Derived for
 * this purpose alone (rate-limit.ts purposeKey); rotating IP_HASH_KEY changes every program's key (RUNBOOK).
 */
export const postbackKey = (secret: Buffer, program: string) =>
  createHmac('sha256', purposeKey(secret, 'affiliate-postback')).update(program).digest('hex');

const postbackPayload = (b: { program: string; orderRef: string; commissionPaise: number; clickToken?: string }) =>
  `${b.program}|${b.orderRef}|${String(b.commissionPaise)}|${b.clickToken ?? ''}`;

export function signPostback(
  secret: Buffer,
  b: { program: string; orderRef: string; commissionPaise: number; clickToken?: string },
): string {
  return createHmac('sha256', postbackKey(secret, b.program)).update(postbackPayload(b)).digest('hex');
}

const uuid = { type: 'string', format: 'uuid' };

export function registerAffiliateRoutes(
  app: FastifyInstance,
  deps: { db: Database; enabled: () => boolean; keySecret: Buffer },
) {
  const { db } = deps;
  const off = (reply: FastifyReply) => fail(reply, 404, 'affiliates_off', 'Affiliate links aren’t available yet.');

  // Sent only after the transaction commits, so a caller acting on the reply finds what it was told exists.
  async function asOwner<T>(userId: string, work: (q: Queryable) => Promise<T>): Promise<T | 'not_owner'> {
    return db.withUser(userId, async q =>
      (await q.query<{ ok: boolean }>('SELECT app.is_owner() AS ok')).rows[0]?.ok === true ? work(q) : 'not_owner',
    );
  }
  const notOwner = (reply: FastifyReply) => fail(reply, 403, 'not_owner', 'This page is for Graphinity’s owner.');

  app.post(
    '/owner/affiliates/programs',
    {
      config: { auth: 'required', write: true, freshAuth: true },
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'host', 'tagParam', 'tagValue'],
          properties: {
            name: { type: 'string', minLength: 2, maxLength: 100, pattern: '^\\S(.*\\S)?$' },
            host: { type: 'string', maxLength: 253, pattern: '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,63}$' },
            tagParam: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_]{0,31}$' },
            tagValue: { type: 'string', pattern: '^[A-Za-z0-9_.-]{1,64}$' },
            clickParam: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_]{0,31}$' },
          },
        },
      },
    },
    async (req, reply) => {
      if (!deps.enabled()) return off(reply);
      const b = req.body as { name: string; host: string; tagParam: string; tagValue: string; clickParam?: string };
      const made = await asOwner(signedIn(req).id, async q => {
        const id = (
          await q.query<{ id: string }>(
            `INSERT INTO app.affiliate_programs (name, host, tag_param, tag_value, click_param) VALUES ($1, $2, $3, $4, $5)
             RETURNING public_id::text AS id`,
            [b.name, b.host, b.tagParam, b.tagValue, b.clickParam ?? null],
          )
        ).rows[0]?.id;
        await auditWithin(q, { action: 'affiliate.program_added', actor: 'owner', subject: id ?? '', detail: {} });
        return id ?? null;
      });
      if (made === 'not_owner') return notOwner(reply);
      // The key goes to the network once, with the agreement; Graphinity can derive it again but never shows it twice.
      return reply.code(201).send({ program: { id: made, postbackKey: postbackKey(deps.keySecret, made ?? '') } });
    },
  );

  app.post(
    '/owner/affiliates/links',
    {
      config: { auth: 'required', write: true, freshAuth: true },
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['program', 'question', 'label', 'destination'],
          properties: {
            program: uuid,
            question: { type: 'string', pattern: '^[1-9][0-9]{0,15}$' },
            label: { type: 'string', minLength: 2, maxLength: 80, pattern: '^\\S(.*\\S)?$' },
            destination: { type: 'string', maxLength: 500, pattern: '^https://[a-z0-9.-]+([/?#][^\\s\\\\]*)?$' },
          },
        },
      },
    },
    async (req, reply) => {
      if (!deps.enabled()) return off(reply);
      const b = req.body as { program: string; question: string; label: string; destination: string };
      let made: { token: string } | null | 'not_owner' | 'wrong_host';
      try {
        made = await asOwner(signedIn(req).id, async q => {
          const token = (
            await q.query<{ token: string }>(
              `INSERT INTO app.affiliate_links (program_id, question_id, label, destination)
               SELECT p.id, $2::bigint, $3, $4 FROM app.affiliate_programs p WHERE p.public_id = $1
               RETURNING token::text`,
              [b.program, b.question, b.label, b.destination],
            )
          ).rows[0]?.token;
          if (token)
            await auditWithin(q, { action: 'affiliate.link_added', actor: 'owner', subject: token, detail: {} });
          return token ? { token } : null;
        });
      } catch (err) {
        if (pgCode(err) === '23514') made = 'wrong_host';
        else if (pgCode(err) === '23503') made = null;
        else throw err;
      }
      if (made === 'not_owner') return notOwner(reply);
      if (made === 'wrong_host')
        return fail(reply, 400, 'wrong_host', 'That link doesn’t go to the program’s own site.');
      if (!made) return fail(reply, 404, 'not_found', 'There’s no such program or question.');
      return reply.code(201).send({ link: { token: made.token } });
    },
  );

  app.delete(
    '/owner/affiliates/links/:token',
    {
      config: { auth: 'required', write: true, freshAuth: true },
      schema: {
        params: { type: 'object', additionalProperties: false, required: ['token'], properties: { token: uuid } },
      },
    },
    async (req, reply) => {
      const { token } = req.params as { token: string };
      const removed = await asOwner(signedIn(req).id, async q => {
        const n = (await q.query('DELETE FROM app.affiliate_links WHERE token = $1', [token])).rowCount ?? 0;
        if (n) await auditWithin(q, { action: 'affiliate.link_removed', actor: 'owner', subject: token, detail: {} });
        return n > 0;
      });
      if (removed === 'not_owner') return notOwner(reply);
      return removed ? reply.code(204).send() : fail(reply, 404, 'not_found', 'There’s no such link.');
    },
  );

  // A question's shop links, each labelled; empty while the switch is off, so a page never has to ask first.
  app.get(
    '/questions/:id/affiliate-links',
    {
      config: { auth: 'optional' },
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['id'],
          properties: { id: { type: 'string', pattern: '^[1-9][0-9]{0,15}$' } },
        },
      },
    },
    async req => {
      if (!deps.enabled()) return { links: [], disclosure: DISCLOSURE };
      const { id } = req.params as { id: string };
      const links = await db.asSystem(
        async q =>
          (
            await q.query<{ token: string; label: string }>(
              `SELECT l.token::text AS token, l.label FROM app.affiliate_links l
               JOIN app.affiliate_programs p ON p.id = l.program_id
               WHERE l.question_id = $1 AND p.active AND NOT app.is_question_hidden(l.question_id) ORDER BY l.id LIMIT 5`,
              [id],
            )
          ).rows,
      );
      return { links, disclosure: DISCLOSURE };
    },
  );

  // Following a link: counted (no person), and the shop's address with the tag. A click token only with the reader's
  // yes to affiliate_optimization and no Sec-GPC; the token names the link, never the reader.
  app.post(
    '/affiliates/go/:token',
    {
      config: { auth: 'optional' },
      schema: {
        params: { type: 'object', additionalProperties: false, required: ['token'], properties: { token: uuid } },
      },
    },
    async (req, reply) => {
      if (!deps.enabled()) return off(reply);
      const { token } = req.params as { token: string };
      const viewer = req.user?.id ?? null;
      const measured =
        viewer !== null &&
        req.headers['sec-gpc'] !== '1' &&
        (await db.withUser(
          viewer,
          async q =>
            (
              await q.query(
                "SELECT 1 FROM app.user_consent_settings WHERE user_id = $1 AND category = 'affiliate_optimization' AND enabled",
                [viewer],
              )
            ).rowCount === 1,
        ));
      const found = await db.asSystem(async q => {
        const link = (
          await q.query<{
            id: string;
            destination: string;
            host: string;
            param: string;
            value: string;
            click: string | null;
          }>(
            `SELECT l.id::text, l.destination, p.host, p.tag_param AS param, p.tag_value AS value, p.click_param AS click
             FROM app.affiliate_links l JOIN app.affiliate_programs p ON p.id = l.program_id
             WHERE l.token = $1 AND p.active AND NOT app.is_question_hidden(l.question_id)`,
            [token],
          )
        ).rows[0];
        if (!link) return null;
        // Read the address as a browser will, and send no one anywhere but the program's own site.
        let parsed: URL;
        try {
          parsed = new URL(link.destination);
        } catch {
          return null;
        }
        if (
          parsed.protocol !== 'https:' ||
          !(parsed.hostname === link.host || parsed.hostname.endsWith(`.${link.host}`))
        )
          return null;
        await q.query(
          `INSERT INTO app.affiliate_clicks AS c (link_id, day, clicks) VALUES ($1, (now() AT TIME ZONE 'UTC')::date, 1)
           ON CONFLICT (link_id, day) DO UPDATE SET clicks = c.clicks + 1`,
          [link.id],
        );
        const clickToken =
          measured && link.click
            ? (
                await q.query<{ token: string }>(
                  'INSERT INTO app.affiliate_click_tokens (link_id) VALUES ($1) RETURNING token::text',
                  [link.id],
                )
              ).rows[0]?.token
            : undefined;
        return { link, clickToken };
      });
      if (!found) return fail(reply, 404, 'not_found', 'That link isn’t available any more.');
      const url = new URL(found.link.destination);
      url.searchParams.set(found.link.param, found.link.value);
      if (found.clickToken && found.link.click) url.searchParams.set(found.link.click, found.clickToken);
      return { url: url.toString(), disclosure: DISCLOSURE };
    },
  );

  // A network's server reports a sale. Signed with the program's own key; each order counted once.
  app.post(
    '/affiliates/postback',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['program', 'orderRef', 'commissionPaise', 'signature'],
          properties: {
            program: uuid,
            orderRef: { type: 'string', minLength: 1, maxLength: 100, pattern: '^[A-Za-z0-9_.:-]+$' },
            commissionPaise: { type: 'integer', minimum: 0, maximum: 100000000 },
            clickToken: uuid,
            signature: { type: 'string', pattern: '^[0-9a-f]{64}$' },
          },
        },
      },
    },
    async (req, reply) => {
      if (!deps.enabled()) return off(reply);
      const b = req.body as {
        program: string;
        orderRef: string;
        commissionPaise: number;
        clickToken?: string;
        signature: string;
      };
      const expected = Buffer.from(signPostback(deps.keySecret, b), 'hex');
      if (!timingSafeEqual(expected, Buffer.from(b.signature, 'hex')))
        return fail(reply, 401, 'bad_signature', 'That report isn’t signed with this program’s key.');
      const counted = await db.asSystem(async q => {
        const program = (
          await q.query<{ id: string }>('SELECT id::text FROM app.affiliate_programs WHERE public_id = $1', [b.program])
        ).rows[0];
        if (!program) return 'unknown' as const;
        const link = b.clickToken
          ? (
              await q.query<{ id: string }>(
                `SELECT t.link_id::text AS id FROM app.affiliate_click_tokens t JOIN app.affiliate_links l ON l.id = t.link_id
                 WHERE t.token = $1 AND l.program_id = $2`,
                [b.clickToken, program.id],
              )
            ).rows[0]?.id
          : undefined;
        const { rowCount } = await q.query(
          `INSERT INTO app.affiliate_conversions (program_id, link_id, order_ref, commission_paise) VALUES ($1, $2, $3, $4)
           ON CONFLICT (program_id, order_ref) DO NOTHING`,
          [program.id, link ?? null, b.orderRef, b.commissionPaise],
        );
        return rowCount ? ('counted' as const) : ('again' as const);
      });
      if (counted === 'unknown') return fail(reply, 404, 'not_found', 'There’s no such program.');
      return { counted: counted === 'counted' };
    },
  );
}
