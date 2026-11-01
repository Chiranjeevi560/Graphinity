// The collusion job (docs/adr/0017-collusion-detection.md): daily, as the
// system, find groups of accounts giving each other points (src/ml/
// collusion.ts) in the last WINDOW_DAYS of picks and helpful marks, and
// record them for moderators (migration 0025). Finding a group again
// refreshes its numbers; its decision, if any, stays. Logs and the result
// hold counts only.
import { createHash } from 'node:crypto';
import type { Database, Queryable } from './db.ts';
import { findRings, type PickEdge, type Ring } from './ml/collusion.ts';
import { denseBlocks, implicated, type BipartiteEdge } from './ml/fraudar.ts';
import { trustInto } from './kg/trust-flow.ts';

export const WINDOW_DAYS = 180;
/** At most this many groups are recorded a run, the most extreme first. */
export const MAX_GROUPS = 200;
/** Evidence is computed for this many, strongest first: each needs a max-flow over the whole graph. */
export const MAX_EVIDENCE = 20;
/** Trust starts at the people who've picked answers from the most different people: costly to fake at scale. */
const TRUST_SEEDS = 20;
const MIN_SEED_REACH = 5;
/** The heaviest picks only: each ring's max-flow runs in the API's process, so its size is capped. */
const MAX_EVIDENCE_EDGES = 20_000;

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

/**
 * For each ring: trust reaching its members from outside it, per member, and how many members fall in a dense block
 * of picks. Picks inside a ring don't count as trust into it: that's the thing being questioned.
 */
export async function ringEvidence(
  allPicks: readonly PickEdge<string>[],
  rings: readonly Pick<Ring<string>, 'members'>[],
): Promise<Array<{ outsideTrust: number; denseMembers: number }>> {
  const picks = [...allPicks].sort((a, b) => (b.count ?? 1) - (a.count ?? 1)).slice(0, MAX_EVIDENCE_EDGES);
  const index = new Map<string, number>();
  const id = (who: string) => {
    let i = index.get(who);
    if (i === undefined) index.set(who, (i = index.size));
    return i;
  };
  const edges: BipartiteEdge[] = picks.map(p => ({ source: id(p.source), target: id(p.target), count: p.count ?? 1 }));
  const reach = new Map<number, Set<number>>();
  for (const e of edges) reach.set(e.source, (reach.get(e.source) ?? new Set()).add(e.target));
  // Who the block implicates, not everyone in it: a dense block's popular targets are mostly honest.
  const dense = new Set(
    denseBlocks(edges, 5, { weighted: true }).flatMap(b => {
      const { sources, targets } = implicated(b, edges);
      return [...sources, ...targets];
    }),
  );
  const out: Array<{ outsideTrust: number; denseMembers: number }> = [];
  for (const ring of rings) {
    // A turn for waiting requests between rings.
    await new Promise(resolve => setImmediate(resolve));
    const members = ring.members.flatMap(m => {
      const i = index.get(m);
      return i === undefined ? [] : [i];
    });
    const inRing = new Set(members);
    const seeds = [...reach]
      .filter(([who, reached]) => !inRing.has(who) && reached.size >= MIN_SEED_REACH)
      .sort((a, b) => b[1].size - a[1].size || a[0] - b[0])
      .slice(0, TRUST_SEEDS)
      .map(([who]) => who);
    const outside = edges
      .filter(e => !(inRing.has(e.source) && inRing.has(e.target)))
      .map(e => [e.source, e.target] as const);
    const trust = seeds.length ? trustInto(index.size, outside, seeds, members) : 0;
    out.push({
      outsideTrust: members.length ? trust / members.length : 0,
      denseMembers: members.filter(m => dense.has(m)).length,
    });
  }
  return out;
}

export async function detectCollusion(db: Pick<Database, 'asSystem'>): Promise<{ found: number; added: number }> {
  const { picks, rings, added } = await db.asSystem(async q => {
    const picks = await loadPickGraph(q);
    const rings = findRings(picks).slice(0, MAX_GROUPS);
    return { picks, rings, added: await recordRings(q, rings) };
  });
  // Outside the transaction that recorded the rings: this is the slow part, and rings mustn't wait on it.
  const top = rings.slice(0, MAX_EVIDENCE);
  const evidence = await ringEvidence(picks, top);
  await db.asSystem(async q => {
    // Evidence for a ring no longer in the top would be shown as if it were current.
    await q.query(
      `DELETE FROM app.collusion_evidence e USING app.collusion_groups g
       WHERE g.id = e.group_id AND NOT g.member_key = ANY($1)`,
      [top.map(r => memberKey(r.members))],
    );
    for (const [i, ring] of top.entries()) {
      const e = evidence[i];
      if (!e) continue;
      await q.query(
        `INSERT INTO app.collusion_evidence (group_id, outside_trust, dense_members)
         SELECT g.id, $2, $3 FROM app.collusion_groups g WHERE g.member_key = $1
         ON CONFLICT (group_id) DO UPDATE
           SET outside_trust = excluded.outside_trust, dense_members = excluded.dense_members, updated_at = now()`,
        [memberKey(ring.members), e.outsideTrust, e.denseMembers],
      );
    }
  });
  return { found: rings.length, added };
}
