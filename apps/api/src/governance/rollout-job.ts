// The governor's five-minute pass (docs/adr/0028-rollout-governor.md).
import type { Database, Queryable } from '../db.ts';
import { mergeBuckets, quantileOf } from '../ops/metrics.ts';
import { audit } from '../platform/jobs.ts';
import { shouldTrip, type Health } from './rollback.ts';

export async function recentHealth(q: Queryable): Promise<Health> {
  const { rows } = await q.query<{ requests: number; errors: number; buckets: number[] }>(
    `SELECT requests, errors, buckets FROM app.ops_minutes
     WHERE minute >= now() - interval '5 minutes' AND route <> '/health'`,
  );
  const buckets: number[] = [];
  let requests = 0;
  let errors = 0;
  for (const r of rows) {
    requests += r.requests;
    errors += r.errors;
    mergeBuckets(buckets, r.buckets);
  }
  return { requests, errors, p95Ms: quantileOf(buckets, 0.95) };
}

/**
 * One pass, every five minutes. Requests aren't attributed to a switch, so when the service
 * degrades during a rollout every switch still in a ring goes off: the cost of a false alarm is
 * a rollout to restart, of a miss is a broken site. Returns what it turned off.
 */
export async function runRolloutGovernor(db: Pick<Database, 'asSystem'>): Promise<string[]> {
  return db.asSystem(async q => {
    if (!shouldTrip(await recentHealth(q))) return [];
    const { rows } = await q.query<{ name: string }>('SELECT name FROM app.trip_rollouts() AS name');
    for (const { name } of rows)
      await audit(q, { action: 'rollout.tripped', actor: 'system', subject: name, detail: {} });
    return rows.map(r => r.name);
  });
}
