// The collusion job (docs/adr/0017-collusion-detection.md): daily, as the
// system, find groups of accounts giving each other points (src/ml/
// collusion.ts) in the last WINDOW_DAYS of picks and helpful marks, and
// record them for moderators (migration 0025). Finding a group again
// refreshes its numbers; its decision, if any, stays. Logs and the result
// hold counts only.
import { createHash } from 'node:crypto';
import type { Database, Queryable } from './db.ts';
import { findRings, type PickEdge, type Ring } from './ml/collusion.ts';

export const WINDOW_DAYS = 180;
/** At most this many groups are recorded a run, the most extreme first. */
export const MAX_GROUPS = 200;

/**
 * A SQL condition true when `column` (a profile id expression) is in a group
 * that is open or confirmed: such accounts don't teach search or routing.
 * Only meaningful as the system or a moderator; anyone else can't see groups.
 */
export const underCollusionReview = (column: string) =>
  `EXISTS (SELECT 1 FROM app.collusion_members cm JOIN app.collusion_groups cg ON cg.id = cm.group_id
           WHERE cm.profile_id = ${column} AND cg.status <> 'dismissed')`;

/** Who picked or marked whose answers, and how often, in the window. Taken-back awards are not picks any more. */
export async function loadPickGraph(q: Queryable): Promise<PickEdge<string>[]> {
  const { rows } = await q.query<{ source: string; target: string; count: number }>(
    `SELECT l.giver_id::text AS source, l.recipient_id::text AS target, count(*)::int AS count
     FROM app.points_ledger l
     WHERE l.reason IN ('selected', 'helpful') AND l.giver_id IS NOT NULL
       AND l.created_at > now() - make_interval(days => $1)
       AND NOT EXISTS (SELECT 1 FROM app.points_ledger r WHERE r.reverses = l.id)
     GROUP BY l.giver_id, l.recipient_id`,
    [WINDOW_DAYS],
  );
  return rows;
}

export const memberKey = (members: readonly string[]) =>
  createHash('sha256')
    .update([...members].sort().join(','))
    .digest('hex');

/** Records each ring: new ones as open, known ones with fresh numbers. Returns how many were new. */
export async function recordRings(q: Queryable, rings: readonly Ring<string>[]): Promise<number> {
  let added = 0;
  for (const ring of rings) {
    const row = (
      await q.query<{ id: string; added: boolean }>(
        `INSERT INTO app.collusion_groups (member_key, members, inside, expected, lift)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (member_key) DO UPDATE
           SET members = EXCLUDED.members, inside = EXCLUDED.inside, expected = EXCLUDED.expected,
               lift = EXCLUDED.lift, seen_at = now()
         RETURNING id::text, (xmax = 0) AS added`,
        [memberKey(ring.members), ring.members.length, ring.inside, ring.expected, ring.lift],
      )
    ).rows[0];
    if (!row?.added) continue;
    added++;
    await q.query(`INSERT INTO app.collusion_members (group_id, profile_id) SELECT $1, unnest($2::uuid[])`, [
      row.id,
      ring.members,
    ]);
  }
  return added;
}

export async function detectCollusion(db: Pick<Database, 'asSystem'>): Promise<{ found: number; added: number }> {
  return db.asSystem(async q => {
    const rings = findRings(await loadPickGraph(q)).slice(0, MAX_GROUPS);
    return { found: rings.length, added: await recordRings(q, rings) };
  });
}
