// Alert delivery (docs/adr/0020-observability.md): every few minutes, the
// problems a moderator should hear about now become one web push each to
// every moderator's devices. A problem is a page-level SLO alert (a ticket
// waits for the operations screen) or a background job that is unhealthy.
// The same problem isn't sent again within COOLDOWN_HOURS while it lasts;
// once it clears, it is marked resolved, and if it comes back it is news
// again. Messages say what is wrong in plain words: no person, no URL.
import type { Queryable } from '../db.ts';
import type { OpsStatus } from './store.ts';

export const COOLDOWN_HOURS = 6;

export interface Problem {
  /** Stable identity of the problem, e.g. "slo:availability:60" or "job:routing". */
  key: string;
  title: string;
  body: string;
}

const windowWords = (minutes: number) =>
  minutes < 60 ? `${String(minutes)} minutes` : `${String(minutes / 60)} hours`;

/** What should reach a moderator now, from the operations status. */
export function problemsOf(status: OpsStatus): Problem[] {
  const out: Problem[] = [];
  for (const a of status.alerts) {
    if (a.severity !== 'page') continue;
    out.push({
      key: `slo:${a.objective}:${String(a.long)}`,
      title: a.objective === 'availability' ? 'Requests are failing' : 'Requests are slow',
      body: `Using up a month’s allowance ${String(Math.round(a.burnLong))} times too fast over the last ${windowWords(a.long)}. Open Operations to see where.`,
    });
  }
  for (const j of status.jobs) {
    if (j.healthy) continue;
    const failed = j.lastFailureAt !== null && (j.lastSuccessAt === null || j.lastFailureAt > j.lastSuccessAt);
    out.push({
      key: `job:${j.job}`,
      title: `${j.label} isn’t working`,
      body: failed
        ? `Its last run failed${j.lastErrorKind ? ` (${j.lastErrorKind})` : ''}. Its log lines say why.`
        : 'It hasn’t finished a run in twice its usual time. Its log lines say why.',
    });
  }
  return out;
}

/**
 * Of the current problems, those to send now; records them as sent and
 * marks every problem that has cleared as resolved. One transaction (the
 * caller's), under one lock, so two servers can't both send.
 */
export async function dueProblems(q: Queryable, problems: readonly Problem[]): Promise<Problem[]> {
  await q.query("SELECT pg_advisory_xact_lock(hashtext('graphinity.ops-alerts'))");
  const keys = problems.map(p => p.key);
  await q.query(`UPDATE app.ops_alerts SET resolved_at = now() WHERE resolved_at IS NULL AND NOT (key = ANY($1))`, [
    keys,
  ]);
  const due = (
    await q.query<{ key: string }>(
      `INSERT INTO app.ops_alerts (key, first_seen_at, last_sent_at)
       SELECT k, now(), now() FROM unnest($1::text[]) AS k
       ON CONFLICT (key) DO UPDATE SET
         first_seen_at = CASE WHEN app.ops_alerts.resolved_at IS NOT NULL THEN now() ELSE app.ops_alerts.first_seen_at END,
         last_sent_at = now(),
         resolved_at = NULL
       WHERE app.ops_alerts.resolved_at IS NOT NULL
          OR app.ops_alerts.last_sent_at < now() - make_interval(hours => $2)
       RETURNING key`,
      [keys, COOLDOWN_HOURS],
    )
  ).rows.map(r => r.key);
  const set = new Set(due);
  return problems.filter(p => set.has(p.key));
}

/** The people to tell: every moderator who isn't blocked. As the system. */
export async function moderatorIds(q: Queryable): Promise<string[]> {
  return (
    await q.query<{ id: string }>(
      `SELECT m.profile_id::text AS id FROM app.moderators m
       WHERE NOT EXISTS (SELECT 1 FROM app.blocks b WHERE b.profile_id = m.profile_id)
       ORDER BY 1`,
    )
  ).rows.map(r => r.id);
}
