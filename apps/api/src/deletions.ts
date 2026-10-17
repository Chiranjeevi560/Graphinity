// Finishing account deletions. Deleting an account removes the profile at
// once; the sign-in itself (which holds the email) lives in Supabase and is
// removed with one admin call. If that call fails, the deletion stays pending
// in app.pending_auth_deletions and the retry job below finishes it, so a
// deletion can never be left half done.
import { subjectHash } from './auth.ts';
import type { AuthAdmin } from './auth-admin.ts';
import type { Database, Queryable } from './db.ts';

/** Longer than the longest token we accept (auth.ts), so no live token outlasts it. */
const REVOKE_FOR = '2 hours';
/** Deletions finished per run; the rest wait for the next run. */
const BATCH = 20;

export interface DeletionDeps {
  db: Database;
  authAdmin: AuthAdmin;
  subjectKey: Buffer;
  log: { warn(obj: object, msg: string): void };
}

/**
 * Refuses this person's tokens for the next two hours. Called when the
 * deletion starts and again when Supabase confirms it, because tokens issued
 * in between are just as valid.
 */
export async function lockOut(q: Queryable, userId: string, subjectKey: Buffer): Promise<void> {
  await q.query(
    `INSERT INTO app.revoked_subjects (subject_hash, until) VALUES ($1, now() + interval '${REVOKE_FOR}')
     ON CONFLICT (subject_hash) DO UPDATE SET until = GREATEST(app.revoked_subjects.until, EXCLUDED.until)`,
    [subjectHash(userId, subjectKey)],
  );
}

/** Asks Supabase to delete the sign-in; on success forgets the pending id. Returns whether it finished. */
export async function finishDeletion(deps: DeletionDeps, userId: string): Promise<boolean> {
  try {
    await deps.authAdmin.deleteUser(userId);
  } catch (err) {
    // The id is personal data: log only what kind of failure it was.
    deps.log.warn({ kind: err instanceof Error ? err.name : 'unknown' }, 'sign-in deletion failed; will retry');
    return false;
  }
  await deps.db.withUser(null, async q => {
    await q.query('DELETE FROM app.pending_auth_deletions WHERE user_id = $1', [userId]);
    await lockOut(q, userId, deps.subjectKey);
  });
  return true;
}

/**
 * Retries every pending deletion that is due. After a failure the next try
 * waits longer (5, 10, 20 … minutes, at most 6 hours), so a Supabase outage
 * isn't met with a flood of requests.
 */
export async function completePendingDeletions(deps: DeletionDeps): Promise<{ completed: number; failed: number }> {
  const due = await deps.db.withUser(null, async q =>
    (await q.query<{ user_id: string; attempts: number }>(
      'SELECT user_id, attempts FROM app.pending_auth_deletions WHERE next_attempt_at <= now() ORDER BY next_attempt_at LIMIT $1',
      [BATCH],
    )).rows);

  let completed = 0;
  let failed = 0;
  for (const { user_id: userId, attempts } of due) {
    if (await finishDeletion(deps, userId)) {
      completed++;
      continue;
    }
    failed++;
    const waitMinutes = Math.min(5 * 2 ** attempts, 360);
    await deps.db.withUser(null, q => q.query(
      'UPDATE app.pending_auth_deletions SET attempts = attempts + 1, next_attempt_at = now() + make_interval(mins => $2) WHERE user_id = $1',
      [userId, waitMinutes],
    ));
  }
  return { completed, failed };
}
