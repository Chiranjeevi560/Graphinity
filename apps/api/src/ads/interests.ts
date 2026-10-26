// The advertising interest graph's collection points (docs/adr/0022-advertising-platform.md
// part 2, migration 0030). A search or a read becomes one signal about a
// topic, recorded by the database only if ads_personalization is permitted
// for the person now; the words themselves are never recorded. Collection
// never gets in the way of what the person was doing: a failure is logged by
// kind and the search or page carries on.
import type { Database } from '../db.ts';
import { errorKind } from '../jobs.ts';

/** A read says less about intent than a search. */
export const READ_WEIGHT = 1;
export const SEARCH_WEIGHT = 2;
/** The topic of a search: its own topic filter, or the one most of its top results share. */
export const TOPIC_RESULTS = 3;

export function searchTopic(filter: string | null, resultFields: readonly string[]): string | null {
  if (filter) return filter;
  const counts = new Map<string, number>();
  for (const f of resultFields.slice(0, TOPIC_RESULTS)) counts.set(f, (counts.get(f) ?? 0) + 1);
  let best: string | null = null;
  let most = 0;
  // First seen wins a tie: the higher-ranked result's topic.
  for (const [f, n] of counts)
    if (n > most) {
      best = f;
      most = n;
    }
  return best;
}

export async function recordAdInterest(
  db: Pick<Database, 'withUser'>,
  log: { warn(obj: object, msg: string): void },
  userId: string,
  field: string,
  weight: number,
): Promise<void> {
  try {
    await db.withUser(userId, q => q.query('SELECT app.record_ad_interest($1, $2, $3)', [userId, field, weight]));
  } catch (err) {
    log.warn({ kind: errorKind(err) }, 'ad interest not recorded');
  }
}
