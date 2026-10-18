// Which networks people write from, as keyed hashes, so the owner can see
// pairs exchanging points from the same place (two accounts, one person?).
// Shown for review only, never acted on automatically: mobile carriers and
// offices share addresses.
import type { Database } from './db.ts';
import { visitorAddress, visitorKey } from './rate-limit.ts';

export function createNetworkMarker(deps: { db: Database; key: Buffer; today: () => string }) {
  // ponytail: per-instance memory of what's already written today, cleared when large.
  const written = new Set<string>();
  return function mark(userId: string, address: string): void {
    // Its own hashing domain: these values can't be matched with the rate limiter's.
    const network = visitorKey(`network:${visitorAddress(address)}`, deps.key);
    const seen = `${userId}|${network}|${deps.today()}`;
    if (written.has(seen)) return;
    if (written.size > 50_000) written.clear();
    written.add(seen);
    deps.db.withUser(userId, q => q.query(
      'INSERT INTO app.network_marks (profile_id, network_hash) VALUES ($1, $2) ON CONFLICT DO NOTHING', [userId, network]))
      // Before the profile exists (setting it up is a write too) there is
      // nothing to mark; any other failure only loses a review hint.
      .catch(() => { written.delete(seen); });
  };
}

/** Forgets marks older than 30 days. Run by the server's background job. */
export async function expireNetworkMarks(db: Database): Promise<number> {
  return db.asSystem(async q => (await q.query("DELETE FROM app.network_marks WHERE day < current_date - 30")).rowCount ?? 0);
}
