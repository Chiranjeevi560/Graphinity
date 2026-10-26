// Building audiences (docs/adr/0022-advertising-platform.md part 7), as the
// server's own job: for each audience, who is in it now, from people who
// allow personalized ads at this moment. Each audience is rebuilt in its own
// transaction (members replaced, then sized); one that comes out under
// MIN_AUDIENCE is marked insufficient and keeps no members at all, so no
// small group is ever stored, matched or sized.
import type { Database, Queryable } from '../db.ts';
import { seededRandom } from '../ml/linalg.ts';
import {
  inSegment,
  lookAlike,
  MIN_AUDIENCE,
  parseRule,
  RETARGET_WINDOW_MS,
  type Expansion,
  type Person,
} from './audiences.ts';

/** Everyone who may be in an audience now: their identity, country, topics and decayed interests. */
export async function loadPeople(q: Queryable): Promise<Person[]> {
  const { rows } = await q.query<{
    ad_id: string;
    country: string | null;
    fields: string[] | null;
    interests: Record<string, number> | null;
  }>(
    `SELECT d.ad_id::text, p.country,
            (SELECT array_agg(f.field ORDER BY f.field) FROM app.profile_fields f WHERE f.profile_id = p.id) AS fields,
            (SELECT jsonb_object_agg(i.field, app.decayed(i.score, i.updated_at)) FROM app.ad_interests i
             WHERE i.ad_id = d.ad_id) AS interests
     FROM app.ad_identities d JOIN app.profiles p ON p.id = d.profile_id
     WHERE app.ads_permitted(p.id, 'ads_personalization')
     ORDER BY d.ad_id`,
  );
  return rows.map(r => ({
    adId: r.ad_id,
    country: r.country,
    fields: r.fields ?? [],
    interests: new Map(Object.entries(r.interests ?? {})),
  }));
}

interface AudienceRow {
  id: string;
  kind: 'segment' | 'retargeting' | 'lookalike';
  rule: unknown;
  source_campaign_id: string | null;
  seed_audience_id: string | null;
  expansion: number | null;
}

/** Who belongs, with when they qualified. */
async function membersOf(
  q: Queryable,
  a: AudienceRow,
  people: readonly Person[],
  topics: readonly string[],
  now: Date,
): Promise<Array<{ adId: string; at: Date }>> {
  if (a.kind === 'segment') {
    const rule = parseRule(a.rule);
    if (!rule) return [];
    return people.filter(p => inSegment(rule, p)).map(p => ({ adId: p.adId, at: now }));
  }
  const allowed = new Set(people.map(p => p.adId));
  if (a.kind === 'retargeting') {
    // People who tapped the campaign's ads recently, each with their latest tap.
    const { rows } = await q.query<{ ad_id: string; at: Date }>(
      `SELECT i.ad_id::text, max(i.clicked_at) AS at FROM app.ad_impressions i
       WHERE i.campaign_id = $1 AND i.ad_id IS NOT NULL AND i.clicked_at > $2
       GROUP BY i.ad_id`,
      [a.source_campaign_id, new Date(now.getTime() - RETARGET_WINDOW_MS)],
    );
    return rows.filter(r => allowed.has(r.ad_id)).map(r => ({ adId: r.ad_id, at: r.at }));
  }
  const seedIds = new Set(
    (
      await q.query<{ ad_id: string }>(
        `SELECT m.ad_id::text FROM app.ad_audience_members m JOIN app.ad_audiences s ON s.id = m.audience_id
         WHERE s.id = $1 AND s.status = 'ready'`,
        [a.seed_audience_id],
      )
    ).rows.map(r => r.ad_id),
  );
  const seed = people.filter(p => seedIds.has(p.adId));
  // Seeded by the audience itself, so a rebuild over the same people gives the same result.
  const random = seededRandom(Number.parseInt(a.id, 10));
  return lookAlike(seed, people, topics, a.expansion as Expansion, random).members.map(adId => ({ adId, at: now }));
}

/** Rebuilds every audience while audiences are on. Returns how many were built. */
export async function buildAudiences(db: Pick<Database, 'asSystem'>, now = new Date()): Promise<number> {
  const work = await db.asSystem(async q => {
    const on = (await q.query<{ on: boolean }>("SELECT app.flag_on('ads') AND app.flag_on('ads_audiences') AS on"))
      .rows[0]?.on;
    if (!on) return null;
    const audiences = (
      await q.query<AudienceRow>(
        // Look-alikes last: they read their seed's fresh members.
        `SELECT id::text, kind, rule, source_campaign_id::text, seed_audience_id::text, expansion
         FROM app.ad_audiences ORDER BY kind = 'lookalike', id`,
      )
    ).rows;
    const topics = (await q.query<{ slug: string }>('SELECT slug FROM app.fields ORDER BY slug')).rows.map(r => r.slug);
    return { audiences, topics, people: await loadPeople(q) };
  });
  if (!work) return 0;
  for (const a of work.audiences)
    await db.asSystem(async q => {
      const members = await membersOf(q, a, work.people, work.topics, now);
      await q.query('DELETE FROM app.ad_audience_members WHERE audience_id = $1', [a.id]);
      const enough = members.length >= MIN_AUDIENCE;
      if (enough)
        await q.query(
          `INSERT INTO app.ad_audience_members (audience_id, ad_id, event_at)
           SELECT $1, m.ad_id, m.at FROM unnest($2::uuid[], $3::timestamptz[]) AS m(ad_id, at)`,
          [a.id, members.map(m => m.adId), members.map(m => m.at)],
        );
      await q.query('UPDATE app.ad_audiences SET status = $2, size = $3, built_at = $4 WHERE id = $1', [
        a.id,
        enough ? 'ready' : 'insufficient',
        enough ? members.length : 0,
        now,
      ]);
    });
  return work.audiences.length;
}
