// The owner's analytics (docs/adr/0029-owner-analytics.md). Hourly, as the system: aggregates computed from
// the live tables in one bounded pass, so the owner's page reads only these rows.
import type { Database } from '../db.ts';
import { associationRules, fpGrowth } from '../commerce/basket.ts';
import { extractProducts, resolveEntities } from '../commerce/entity.ts';
import { TDigest } from './sketches.ts';

/** Fewest distinct people a basket rule may stand on, the same floor as other commerce figures. */
export const MIN_RULE_PEOPLE = 25;
const BASKET_DAYS = 90;
const BASKET_ROWS = 100_000;
const COHORT_WEEKS = 12;

export async function retentionRollup(db: Pick<Database, 'asSystem'>): Promise<number> {
  return db.asSystem(async q => {
    const { rowCount } = await q.query(
      `WITH cohorts AS (
         SELECT p.id, date_trunc('week', p.created_at AT TIME ZONE 'UTC')::date AS cohort
         FROM app.profiles p WHERE p.created_at >= now() - make_interval(weeks => $1)
       ), sizes AS (SELECT cohort, count(*)::int AS size FROM cohorts GROUP BY cohort),
       acts AS (
         SELECT asker_id AS id, created_at AS at FROM app.questions WHERE created_at >= now() - make_interval(weeks => $1)
         UNION ALL
         SELECT answerer_id, created_at FROM app.answers WHERE created_at >= now() - make_interval(weeks => $1)
       ), weeks AS (
         SELECT c.cohort, ((date_trunc('week', a.at AT TIME ZONE 'UTC')::date - c.cohort) / 7)::int AS w, count(DISTINCT c.id)::int AS active
         FROM cohorts c JOIN acts a ON a.id = c.id GROUP BY 1, 2
       )
       INSERT INTO app.olap_cohort_retention (cohort_week, week_offset, cohort_size, active)
       SELECT w.cohort, w.w, s.size, w.active FROM weeks w JOIN sizes s USING (cohort) WHERE w.w BETWEEN 0 AND 12
       ON CONFLICT (cohort_week, week_offset) DO UPDATE SET cohort_size = excluded.cohort_size, active = excluded.active`,
      [COHORT_WEEKS],
    );
    return rowCount ?? 0;
  });
}

/** Questions asked at least 4 days ago, in the last 30 days: how they went, per day and field. */
export async function answeringRollup(db: Pick<Database, 'asSystem'>): Promise<number> {
  return db.asSystem(async q => {
    const { rows } = await q.query<{ day: string; field: string; minutes: number | null; resolved: boolean }>(
      `SELECT to_char(q.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, q.field,
              (SELECT extract(epoch FROM min(a.created_at) - q.created_at) / 60 FROM app.answers a WHERE a.question_id = q.id)::float8 AS minutes,
              (EXISTS (SELECT 1 FROM app.selections s WHERE s.question_id = q.id AND s.selected_at <= q.created_at + interval '4 days')
               OR EXISTS (SELECT 1 FROM app.helpful_marks h JOIN app.answers a ON a.id = h.answer_id
                          WHERE a.question_id = q.id AND h.marked_at <= q.created_at + interval '4 days')) AS resolved
       FROM app.questions q
       WHERE q.created_at >= now() - interval '30 days' AND q.created_at < now() - interval '4 days'`,
    );
    const cells = new Map<string, { digest: TDigest; questions: number; resolved: number; answered: number }>();
    for (const r of rows) {
      const k = `${r.day}|${r.field}`;
      const c = cells.get(k) ?? { digest: new TDigest(), questions: 0, resolved: 0, answered: 0 };
      c.questions += 1;
      if (r.resolved) c.resolved += 1;
      if (r.minutes !== null) {
        c.answered += 1;
        c.digest.add(r.minutes);
      }
      cells.set(k, c);
    }
    for (const [k, c] of cells) {
      const [day, field] = k.split('|');
      await q.query(
        `INSERT INTO app.olap_daily_answering (day, field_id, questions, resolved_4d, answered, tdigest_minutes)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (day, field_id) DO UPDATE SET questions = excluded.questions, resolved_4d = excluded.resolved_4d,
           answered = excluded.answered, tdigest_minutes = excluded.tdigest_minutes`,
        [day, field, c.questions, c.resolved, c.answered, c.digest.toBytes()],
      );
    }
    return cells.size;
  });
}

/**
 * Which products the same people ask about, over 90 days. A basket is one person's products, so one
 * person asking many times counts once. Rules below 25 people aren't kept: the table is replaced each run.
 */
export async function basketRollup(db: Pick<Database, 'asSystem'>): Promise<number> {
  return db.asSystem(async q => {
    const { rows } = await q.query<{ asker: string; title: string }>(
      `SELECT asker_id::text AS asker, title FROM app.questions
       WHERE created_at >= now() - make_interval(days => $1) AND NOT app.is_question_hidden(id) LIMIT $2`,
      [BASKET_DAYS, BASKET_ROWS],
    );
    const seen = new Map<string, { brand: string; label: string; count: number }>();
    const raw = new Map<string, Set<string>>();
    for (const r of rows)
      for (const p of extractProducts(r.title)) {
        const m = seen.get(p.key) ?? { brand: p.brand, label: p.label, count: 0 };
        m.count += 1;
        seen.set(p.key, m);
        raw.set(r.asker, (raw.get(r.asker) ?? new Set()).add(p.key));
      }
    const canonical = resolveEntities([...seen].map(([key, m]) => ({ key, brand: m.brand, count: m.count })));
    const baskets = [...raw.values()].map(set => ({ items: [...new Set([...set].map(k => canonical.get(k) ?? k))] }));
    const rules = associationRules(fpGrowth(baskets, MIN_RULE_PEOPLE, 2), baskets.length).slice(0, 500);
    await q.query('DELETE FROM app.olap_commerce_rules');
    // A product in a rule has passed the floor, so it may be named: the daily rollup may not have reached it yet.
    const ids = new Map<string, string>();
    for (const key of new Set(rules.flatMap(r => [r.from, r.to]))) {
      const m = seen.get(key);
      if (!m) continue;
      const row = (
        await q.query<{ id: string }>(
          `INSERT INTO app.products (key, brand, label, k_reached) VALUES ($1, $2, $3, true)
           ON CONFLICT (key) DO UPDATE SET k_reached = true RETURNING id::text`,
          [key.slice(0, 80), m.brand, m.label.slice(0, 120)],
        )
      ).rows[0];
      if (row) ids.set(key, row.id);
    }
    let written = 0;
    for (const r of rules) {
      const [from, to] = [ids.get(r.from), ids.get(r.to)];
      if (!from || !to) continue;
      await q.query(
        'INSERT INTO app.olap_commerce_rules (from_product, to_product, people, confidence, lift) VALUES ($1, $2, $3, $4, $5)',
        [from, to, Math.round(r.support * baskets.length), Math.min(1, r.confidence), r.lift],
      );
      written += 1;
    }
    return written;
  });
}

export const retentionRates = (
  rows: ReadonlyArray<{ cohort_week: string; week_offset: number; cohort_size: number; active: number }>,
) => {
  const out = new Map<string, { week: string; size: number; weeks: Array<number | null> }>();
  for (const r of rows) {
    const c = out.get(r.cohort_week) ?? { week: r.cohort_week, size: r.cohort_size, weeks: [] };
    while (c.weeks.length <= r.week_offset) c.weeks.push(null);
    c.weeks[r.week_offset] = r.cohort_size ? Math.round((r.active / r.cohort_size) * 1000) / 1000 : 0;
    out.set(r.cohort_week, c);
  }
  return [...out.values()].sort((a, b) => a.week.localeCompare(b.week));
};

/**
 * How many weeks a new person stays, from retention: over weeks since joining, the share still active, each week counting
 * every cohort old enough to have reached it. The rollup writes no row for a week nobody was active, and leaving those
 * out would read as everyone having stayed. Only 13 weeks are kept, which understates a long stay.
 */
export function expectedWeeks(
  rows: ReadonlyArray<{ cohort_week: string; week_offset: number; cohort_size: number; active: number }>,
  now: number,
): number {
  const sizes = new Map(rows.map(r => [r.cohort_week, r.cohort_size]));
  let weeks = 0;
  for (let offset = 0; offset <= 12; offset++) {
    let size = 0;
    for (const [week, n] of sizes) if (Date.parse(week) + offset * 7 * 86_400_000 <= now) size += n;
    const active = rows.filter(r => r.week_offset === offset).reduce((sum, r) => sum + r.active, 0);
    if (size) weeks += active / size;
  }
  return weeks;
}

/**
 * Income per active person-week times expected weeks, against spend per person who joined. Rough, and the page says so:
 * income comes from everyone while activity counts recent joiners who asked or answered, so this can run high, and the
 * short stay window pulls it low. Null where a part is missing, never zero: "no figure yet" and "it costs nothing" differ.
 */
export function unitEconomics(input: {
  revenueMicros: number;
  personWeeks: number;
  lifetimeWeeks: number;
  spendMicros: number | null;
  joined: number;
}) {
  const { revenueMicros, personWeeks, lifetimeWeeks, spendMicros, joined } = input;
  const lifetimeValueMicros =
    personWeeks > 0 && lifetimeWeeks > 0 ? (revenueMicros / personWeeks) * lifetimeWeeks : null;
  const costPerJoinMicros = spendMicros !== null && joined > 0 ? spendMicros / joined : null;
  return { lifetimeValueMicros, costPerJoinMicros };
}
