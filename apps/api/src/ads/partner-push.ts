// Sending a partner a cohort: rotating ids of people who allow partner use and are interested in a topic (ADR 0022
// part 9). Guards, because this is the one place people's ids leave on a schedule rather than on a page they opened:
// - off unless `ads_partner_push`, `ads` and the partner's own push address all say yes;
// - only people `ads_permitted` allows today, so withdrawing or a country not approved stops the next push;
// - nothing under 100 people per topic: a smaller list could name someone;
// - each id is scoped to this partner and rotates monthly, so two partners can't join their lists, and it can't be
//   joined to a bid request either;
// - at most once a day per topic: the ledger is written before sending, so a retry can't send twice;
// - https only with no redirects, checked again when the address is stored (migration 0064).
import { createHmac } from 'node:crypto';
import type { Database } from '../db.ts';
import { eid } from './rtb.ts';

export const MIN_COHORT = 100;
export const MAX_COHORT = 50_000;
/** The charter's "high intent": interest recently enough and strongly enough to mean something. */
export const MIN_INTEREST = 0.75;
export const MAX_AGE_DAYS = 30;
const TIMEOUT_MS = 5000;

export type PushFetcher = (
  url: string,
  init: { method: 'POST'; headers: Record<string, string>; body: string; signal: AbortSignal; redirect: 'error' },
) => Promise<{ status: number }>;

/** The key a partner verifies with, different for each: given to them once a contract exists. */
export const pushKey = (secret: Buffer, partner: string) =>
  createHmac('sha256', secret).update(`partner-push:${partner}`).digest();

export async function pushCohorts(
  db: Pick<Database, 'asSystem'>,
  fetcher: PushFetcher,
  secret: Buffer,
  now: number,
): Promise<number> {
  const day = new Date(now).toISOString().slice(0, 10);
  const plan = await db.asSystem(async q => {
    const on = await q.query<{ ok: boolean }>(`SELECT app.flag_on('ads') AND app.flag_on('ads_partner_push') AS ok`);
    if (!on.rows[0]?.ok) return [];
    const partners = (
      await q.query<{ id: string; url: string }>(
        `SELECT id::text AS id, push_endpoint AS url FROM app.ad_partners WHERE enabled AND push_endpoint IS NOT NULL`,
      )
    ).rows;
    if (!partners.length) return [];
    const { rows } = await q.query<{ field: string; ids: string[] }>(
      `SELECT x.field, array_agg(x.ad_id::text) AS ids FROM (
         SELECT a.field, a.ad_id, row_number() OVER (PARTITION BY a.field ORDER BY a.score DESC) AS place
         FROM app.ad_interests a JOIN app.ad_identities i ON i.ad_id = a.ad_id
         WHERE a.score >= $1 AND a.updated_at > $3::timestamptz - make_interval(days => $2)
           AND app.ads_permitted(i.profile_id, 'ads_partner_sites')
       ) x WHERE x.place <= $4 GROUP BY x.field HAVING count(*) >= $5`,
      [MIN_INTEREST, MAX_AGE_DAYS, new Date(now), MAX_COHORT, MIN_COHORT],
    );
    const sends: Array<{ partner: string; url: string; field: string; ids: string[] }> = [];
    for (const p of partners)
      for (const r of rows) {
        const claimed = await q.query(
          `INSERT INTO app.ad_partner_pushes (partner_id, field, day, people) VALUES ($1, $2, $3, $4)
           ON CONFLICT (partner_id, field, day) DO NOTHING`,
          [p.id, r.field, day, r.ids.length],
        );
        if (claimed.rowCount) sends.push({ partner: p.id, url: p.url, field: r.field, ids: r.ids });
      }
    return sends;
  });
  let delivered = 0;
  // Outside the transaction: a slow partner never holds a database connection.
  for (const s of plan) {
    const body = JSON.stringify({
      day,
      segment: s.field,
      eids: s.ids.map(id => eid(secret, id, now, null, `push:${s.partner}`)),
    });
    const signature = createHmac('sha256', pushKey(secret, s.partner)).update(body).digest('hex');
    try {
      const res = await fetcher(s.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-graphinity-signature': signature },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: 'error',
      });
      if (res.status >= 200 && res.status < 300) {
        delivered += 1;
        await db.asSystem(q =>
          q.query(
            `UPDATE app.ad_partner_pushes SET delivered = true WHERE partner_id = $1 AND field = $2 AND day = $3`,
            [s.partner, s.field, day],
          ),
        );
      }
    } catch {
      // Not retried today, by design: the next chance is tomorrow's list. `delivered` stays false for the owner to see.
      continue;
    }
  }
  return delivered;
}
