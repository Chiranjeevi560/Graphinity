import type { FastifyInstance, FastifyReply } from 'fastify';
import type { AuthAdmin } from '../auth-admin.ts';
import type { Database, Queryable } from '../db.ts';
import { finishDeletion, lockOut, type DeletionDeps } from '../deletions.ts';
import { handleProblem, handleProblemMessages, normalizeHandle } from '../handles.ts';
import type { Clock } from '../rate-limit.ts';
import { fail, pgCode, pgConstraint, signedIn } from './common.ts';
import { isBlocked, isModerator } from './moderation.ts';
import { standing } from './points.ts';

export interface ProfileDeps {
  db: Database;
  authAdmin: AuthAdmin;
  clock: Clock;
  subjectKey: Buffer;
  log: DeletionDeps['log'];
}

/** A display name can change once a week, so nobody can hop between names to confuse people. */
export const HANDLE_COOLDOWN_MS = 7 * 24 * 3600 * 1000;

interface ProfileRow {
  id: string;
  handle: string;
  country: string;
  country_name: string;
  created_at: Date;
  handle_changed_at: Date | null;
  fields: Array<{ slug: string; name: string }>;
}

const PROFILE_SELECT = `
  SELECT p.id, p.handle, p.country, c.name AS country_name, p.created_at, p.handle_changed_at,
         COALESCE(json_agg(json_build_object('slug', f.slug, 'name', f.name) ORDER BY f.position)
                  FILTER (WHERE f.slug IS NOT NULL), '[]') AS fields
  FROM app.profiles p
  JOIN app.countries c ON c.code = p.country
  LEFT JOIN app.profile_fields pf ON pf.profile_id = p.id
  LEFT JOIN app.fields f ON f.slug = pf.field`;

async function loadProfile(q: Queryable, where: 'id' | 'handle', value: string): Promise<ProfileRow | null> {
  const { rows } = await q.query<ProfileRow>(`${PROFILE_SELECT} WHERE p.${where} = $1 GROUP BY p.id, c.name`, [value]);
  return rows[0] ?? null;
}

/** Reading back a row written earlier in the same transaction: it must exist. */
async function loadOwn(q: Queryable, userId: string): Promise<ProfileRow> {
  const profile = await loadProfile(q, 'id', userId);
  if (!profile) throw new Error('profile missing inside the transaction that wrote it');
  return profile;
}

/** What anyone may see. No id, no timestamps beyond the month joined. */
function publicProfile(p: ProfileRow) {
  return {
    handle: p.handle,
    country: { code: p.country, name: p.country_name },
    fields: p.fields,
    joined: p.created_at.toISOString().slice(0, 7),
  };
}

function ownProfile(p: ProfileRow) {
  const next = p.handle_changed_at ? new Date(p.handle_changed_at.getTime() + HANDLE_COOLDOWN_MS) : null;
  return { ...publicProfile(p), handleChangeAvailableAt: next?.toISOString() ?? null };
}

const handleSchema = { type: 'string', minLength: 1, maxLength: 64 } as const;
const countrySchema = { type: 'string', pattern: '^[A-Z]{2}$' } as const;
const fieldsSchema = {
  type: 'array',
  minItems: 1,
  maxItems: 8,
  uniqueItems: true,
  items: { type: 'string', pattern: '^[a-z]+(-[a-z]+)*$', maxLength: 40 },
} as const;

/** Turns database refusals into answers a person can act on. Returns false if unrecognised. */
function explainDbError(err: unknown, reply: FastifyReply): boolean {
  const code = pgCode(err);
  if (code === '23505' && pgConstraint(err) === 'profiles_handle_key') {
    fail(reply, 409, 'handle_taken', 'That name is taken. Try another.');
    return true;
  }
  if (code === '23505' && pgConstraint(err) === 'profiles_pkey') {
    fail(reply, 409, 'profile_exists', 'You already have a profile.');
    return true;
  }
  // Unknown country or field, or a rule the database enforces (field count, name rule).
  if (code === '23503' || code === '23514') {
    fail(reply, 400, 'invalid_request', 'Some of what was sent isn’t allowed. Check it and try again.');
    return true;
  }
  return false;
}

async function replaceFields(q: Queryable, userId: string, fields: string[]) {
  await q.query('DELETE FROM app.profile_fields WHERE profile_id = $1', [userId]);
  await q.query('INSERT INTO app.profile_fields (profile_id, field) SELECT $1, unnest($2::text[])', [userId, fields]);
}

export function registerProfileRoutes(app: FastifyInstance, deps: ProfileDeps) {
  const { db, clock, subjectKey } = deps;

  // Lists for the profile form. They only change when a migration is
  // applied (and the server redeployed), so they are read once and kept.
  let meta: Promise<{ fields: unknown[]; countries: unknown[] }> | null = null;
  app.get('/meta', async (_req, reply) => {
    meta ??= db
      .withUser(null, async q => ({
        fields: (await q.query('SELECT slug, name FROM app.fields ORDER BY position')).rows,
        countries: (await q.query('SELECT code, name FROM app.countries ORDER BY name')).rows,
      }))
      .catch((err: unknown) => {
        meta = null;
        throw err;
      });
    reply.header('cache-control', 'public, max-age=3600');
    return meta;
  });

  app.get('/me', { config: { auth: 'required' } }, async req => {
    const user = signedIn(req);
    const found = await db.withUser(user.id, async q => {
      const profile = await loadProfile(q, 'id', user.id);
      return profile
        ? {
            profile,
            standing: await standing(q, profile.id),
            moderator: await isModerator(q),
            blocked: await isBlocked(q),
          }
        : null;
    });
    // No profile yet means the person signed in but hasn't finished setting up.
    return found
      ? {
          profile: ownProfile(found.profile),
          standing: found.standing,
          moderator: found.moderator,
          blocked: found.blocked,
        }
      : { profile: null };
  });

  app.post(
    '/me/profile',
    {
      config: { auth: 'required', write: true },
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['handle', 'country', 'fields', 'adult'],
          properties: { handle: handleSchema, country: countrySchema, fields: fieldsSchema, adult: { const: true } },
        },
      },
    },
    async (req, reply) => {
      const user = signedIn(req);
      const body = req.body as { handle: string; country: string; fields: string[] };
      const handle = normalizeHandle(body.handle);
      const problem = handleProblem(handle);
      if (problem) return fail(reply, 400, 'invalid_handle', handleProblemMessages[problem], { reason: problem });
      let profile: ProfileRow;
      try {
        profile = await db.withUser(user.id, async q => {
          await q.query('INSERT INTO app.profiles (id, handle, country, adult_confirmed_at) VALUES ($1, $2, $3, $4)', [
            user.id,
            handle,
            body.country,
            new Date(clock.now()),
          ]);
          await replaceFields(q, user.id, body.fields);
          return loadOwn(q, user.id);
        });
      } catch (err) {
        if (explainDbError(err, reply)) return reply;
        throw err;
      }
      return reply.code(201).send({ profile: ownProfile(profile) });
    },
  );

  app.patch(
    '/me/profile',
    {
      config: { auth: 'required', write: true },
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          minProperties: 1,
          properties: { handle: handleSchema, country: countrySchema, fields: fieldsSchema },
        },
      },
    },
    async (req, reply) => {
      const user = signedIn(req);
      const body = req.body as { handle?: string; country?: string; fields?: string[] };
      const handle = body.handle === undefined ? undefined : normalizeHandle(body.handle);
      if (handle !== undefined) {
        const problem = handleProblem(handle);
        if (problem) return fail(reply, 400, 'invalid_handle', handleProblemMessages[problem], { reason: problem });
      }
      let outcome:
        { kind: 'missing' } | { kind: 'too_soon'; availableAt: string } | { kind: 'ok'; profile: ProfileRow };
      try {
        outcome = await db.withUser(user.id, async q => {
          // Lock the row so two edits at once can't both pass the weekly check.
          // The database's clock decides (it also enforces the rule itself).
          const { rows } = await q.query<{ handle: string; available_at: Date | null; too_soon: boolean }>(
            `SELECT handle, handle_changed_at + interval '7 days' AS available_at,
                  COALESCE(handle_changed_at + interval '7 days' > now(), false) AS too_soon
           FROM app.profiles WHERE id = $1 FOR UPDATE`,
            [user.id],
          );
          const current = rows[0];
          if (!current) return { kind: 'missing' as const };
          const now = clock.now();
          if (handle !== undefined && handle !== current.handle) {
            if (current.too_soon && current.available_at) {
              return { kind: 'too_soon' as const, availableAt: current.available_at.toISOString() };
            }
            await q.query('UPDATE app.profiles SET handle = $2 WHERE id = $1', [user.id, handle]);
          }
          if (body.country !== undefined) {
            await q.query('UPDATE app.profiles SET country = $2 WHERE id = $1', [user.id, body.country]);
          }
          if (body.fields !== undefined) await replaceFields(q, user.id, body.fields);
          await q.query('UPDATE app.profiles SET updated_at = $2 WHERE id = $1', [user.id, new Date(now)]);
          return { kind: 'ok' as const, profile: await loadOwn(q, user.id) };
        });
      } catch (err) {
        if (explainDbError(err, reply)) return reply;
        throw err;
      }
      if (outcome.kind === 'missing') return fail(reply, 404, 'no_profile', 'Set up your profile first.');
      if (outcome.kind === 'too_soon') {
        return fail(
          reply,
          409,
          'handle_change_too_soon',
          'You changed your name recently. You can change it again in a few days.',
          { availableAt: outcome.availableAt },
        );
      }
      return { profile: ownProfile(outcome.profile) };
    },
  );

  // Live feedback while someone types a name. Signed-in only, so it can't be
  // used anonymously to list who is on Graphinity.
  app.get(
    '/handles/:handle',
    {
      config: { auth: 'required' },
      schema: { params: { type: 'object', properties: { handle: handleSchema }, required: ['handle'] } },
    },
    async req => {
      const user = signedIn(req);
      const handle = normalizeHandle((req.params as { handle: string }).handle);
      const problem = handleProblem(handle);
      if (problem) return { handle, available: false, reason: problem, message: handleProblemMessages[problem] };
      const owner = await db.withUser(
        user.id,
        async q =>
          (await q.query<{ id: string }>('SELECT id FROM app.profiles WHERE handle = $1', [handle])).rows[0]?.id,
      );
      if (owner && owner !== user.id)
        return { handle, available: false, reason: 'taken', message: 'That name is taken. Try another.' };
      return { handle, available: true };
    },
  );

  app.get(
    '/profiles/:handle',
    {
      schema: { params: { type: 'object', properties: { handle: handleSchema }, required: ['handle'] } },
    },
    async (req, reply) => {
      const handle = normalizeHandle((req.params as { handle: string }).handle);
      const found = handleProblem(handle)
        ? null
        : await db.withUser(null, async q => {
            const profile = await loadProfile(q, 'handle', handle);
            return profile ? { profile, standing: await standing(q, profile.id) } : null;
          });
      if (!found) return fail(reply, 404, 'not_found', 'There’s no one with that name.');
      return { profile: publicProfile(found.profile), standing: found.standing };
    },
  );

  // Deleting an account really deletes it: the profile and everything that
  // cascades from it at once, then the sign-in at Supabase. If Supabase fails,
  // the deletion is recorded as pending and finished by the retry job
  // (deletions.ts); until then the account is refused everywhere and the
  // database won't accept a new profile for it. Safe to call again.
  app.delete(
    '/me',
    {
      config: { auth: 'required', write: true, allowRevoked: true },
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['confirm'],
          properties: { confirm: { const: true } },
        },
      },
    },
    async (req, reply) => {
      const user = signedIn(req);
      await db.withUser(user.id, async q => {
        await q.query('DELETE FROM app.revoked_subjects WHERE until < now()');
        await q.query('DELETE FROM app.profiles WHERE id = $1', [user.id]);
        await q.query('INSERT INTO app.pending_auth_deletions (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING', [
          user.id,
        ]);
        await lockOut(q, user.id, subjectKey);
      });
      if (await finishDeletion({ db, authAdmin: deps.authAdmin, subjectKey, log: deps.log }, user.id)) {
        return reply.code(204).send();
      }
      return reply.code(202).send({
        status: 'finishing',
        message:
          'Your account is deleted. Removing your sign-in is taking longer than usual; it will finish automatically.',
      });
    },
  );
}
