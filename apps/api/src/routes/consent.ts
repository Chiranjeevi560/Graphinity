import type { FastifyInstance } from 'fastify';
import type { Database } from '../db.ts';
import { fail, signedIn } from './common.ts';

export interface ConsentDeps {
  db: Database;
}

const choicesSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['choices'],
  properties: {
    choices: {
      type: 'array',
      minItems: 1,
      maxItems: 32,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['category', 'enabled'],
        properties: {
          category: { type: 'string', pattern: '^[a-z][a-z0-9_]{0,39}$' },
          enabled: { type: 'boolean' },
        },
      },
    },
  },
} as const;

/** Consent is purpose-specific, default-off, and written with an append-only choice history. */
export function registerConsentRoutes(app: FastifyInstance, deps: ConsentDeps) {
  app.get('/me/consents', { config: { auth: 'required' } }, async req => {
    const user = signedIn(req);
    return deps.db.withUser(user.id, async q => {
      const { rows } = await q.query<{ name: string; awaitingAnswer: boolean } & Record<string, unknown>>(
        `SELECT c.name, c.purpose, c.data_description AS "dataDescription", c.retention,
                c.recipients, c.policy_version AS "policyVersion",
                c.required_for_service AS "requiredForService",
                COALESCE(s.enabled, c.required_for_service) AS enabled,
                s.updated_at AS "updatedAt",
                -- Asked once (migration 0019): waiting while the person has never answered it.
                (c.prompt_once AND s.user_id IS NULL) AS "awaitingAnswer"
         FROM app.consent_categories c
         LEFT JOIN app.user_consent_settings s ON s.category = c.name AND s.user_id = $1
         -- Purposes not offered now (advertising while it's off, migration 0029) are left out,
         -- unless the person has one on: they can always turn it off.
         WHERE app.consent_offered(c.name) OR coalesce(s.enabled, false)
         ORDER BY c.required_for_service DESC, c.name`,
        [user.id],
      );
      return {
        categories: rows,
        // The one-time privacy update: purposes to ask about now. Any answer, yes or no, is recorded
        // through PUT, after which they never appear here again.
        awaitingAnswer: rows
          .filter(r => (r as { awaitingAnswer: boolean }).awaitingAnswer)
          .map(r => (r as { name: string }).name),
      };
    });
  });

  app.get('/me/consents/audit', { config: { auth: 'required' } }, async req => {
    const user = signedIn(req);
    return deps.db.withUser(user.id, async q => {
      const { rows } = await q.query(
        `SELECT a.category, c.purpose, a.enabled, a.policy_version AS "policyVersion",
                a.source, a.changed_at AS "changedAt"
         FROM app.user_consent_audit_log a
         JOIN app.consent_categories c ON c.name = a.category
         WHERE a.user_id = $1 ORDER BY a.changed_at DESC, a.id DESC LIMIT 500`,
        [user.id],
      );
      return { history: rows };
    });
  });

  app.put(
    '/me/consents',
    { config: { auth: 'required', write: true }, schema: { body: choicesSchema } },
    async (req, reply) => {
      const user = signedIn(req);
      const { choices } = req.body as { choices: Array<{ category: string; enabled: boolean }> };
      if (new Set(choices.map(choice => choice.category)).size !== choices.length) {
        return fail(reply, 400, 'duplicate_consent_category', 'Choose each data use only once.');
      }

      const result = await deps.db.withUser(user.id, async q => {
        const categories = await q.query<{
          name: string;
          policy_version: number;
          required_for_service: boolean;
          offered: boolean;
        }>(
          `SELECT name, policy_version, required_for_service, app.consent_offered(name) AS offered
           FROM app.consent_categories WHERE name = ANY($1::text[])`,
          [choices.map(choice => choice.category)],
        );
        if (categories.rows.length !== choices.length) return { error: 'unknown' as const };
        const offered = new Map(categories.rows.map(c => [c.name, c.offered]));
        if (choices.some(choice => choice.enabled && !offered.get(choice.category)))
          return { error: 'unknown' as const };
        const byName = new Map(categories.rows.map(category => [category.name, category]));
        if (choices.some(choice => byName.get(choice.category)?.required_for_service && !choice.enabled)) {
          return { error: 'required' as const };
        }

        let changed = 0;
        for (const choice of choices) {
          const category = byName.get(choice.category);
          if (!category) return { error: 'unknown' as const };
          const { rows } = await q.query<{ category: string }>(
            `INSERT INTO app.user_consent_settings (user_id, category, enabled, policy_version, source)
             VALUES ($1, $2, $3, $4, 'settings')
             ON CONFLICT (user_id, category) DO UPDATE SET
               enabled = EXCLUDED.enabled, policy_version = EXCLUDED.policy_version,
               source = EXCLUDED.source, updated_at = now()
             WHERE app.user_consent_settings.enabled IS DISTINCT FROM EXCLUDED.enabled
                OR app.user_consent_settings.policy_version IS DISTINCT FROM EXCLUDED.policy_version
             RETURNING category`,
            [user.id, choice.category, choice.enabled, category.policy_version],
          );
          if (rows.length) {
            await q.query(
              `INSERT INTO app.user_consent_audit_log (user_id, category, enabled, policy_version, source)
               VALUES ($1, $2, $3, $4, 'settings')`,
              [user.id, choice.category, choice.enabled, category.policy_version],
            );
            changed += 1;
          }
        }
        return { changed };
      });

      if ('error' in result) {
        if (result.error === 'required') {
          return fail(reply, 400, 'required_consent', 'This data use is needed to provide your account.');
        }
        return fail(reply, 400, 'unknown_consent_category', 'One or more data uses are not available.');
      }
      return { changed: result.changed };
    },
  );
}
