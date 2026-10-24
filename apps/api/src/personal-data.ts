import type { Database } from './db.ts';

/** Removes only signal events whose documented expiry time has passed. */
export async function purgeExpiredPersonalSignals(db: Pick<Database, 'query'>): Promise<number> {
  const { rows } = await db.query<{ deleted: string | number }>(
    'SELECT app.purge_expired_personal_signals() AS deleted',
  );
  const count = Number(rows[0]?.deleted ?? 0);
  if (!Number.isSafeInteger(count) || count < 0) throw new Error('invalid personal signal cleanup count');
  return count;
}

/** Claims a bounded batch and projects consented interaction events into the owner's graph. */
export async function projectPersonalGraphSignals(db: Pick<Database, 'asSystem'>, batchSize = 100): Promise<number> {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 500) {
    throw new RangeError('personal graph projection batch must be between 1 and 500');
  }
  return db.asSystem(async q => {
    const { rows } = await q.query<{ projected: number }>('SELECT app.project_personal_graph_events($1) AS projected', [
      batchSize,
    ]);
    const count = rows[0]?.projected ?? 0;
    if (!Number.isSafeInteger(count) || count < 0 || count > batchSize) {
      throw new Error('invalid personal graph projection count');
    }
    return count;
  });
}

export interface PersonalGraphQueueStatus {
  pending: number;
  oldestSeconds: number;
}

/** Aggregate queue health without returning user ids or event contents. */
export async function personalGraphQueueStatus(db: Pick<Database, 'asSystem'>): Promise<PersonalGraphQueueStatus> {
  return db.asSystem(async q => {
    const { rows } = await q.query<{ pending: string | number; oldest_seconds: number }>(
      'SELECT pending, oldest_seconds FROM app.personal_graph_projection_status()',
    );
    const pending = Number(rows[0]?.pending ?? 0);
    const oldestSeconds = rows[0]?.oldest_seconds ?? 0;
    if (!Number.isSafeInteger(pending) || pending < 0 || !Number.isFinite(oldestSeconds) || oldestSeconds < 0) {
      throw new Error('invalid personal graph queue status');
    }
    return { pending, oldestSeconds };
  });
}
