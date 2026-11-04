// Click tokens (ADR 0036) are kept 90 days: long enough for a network to report a sale, then gone.
import type { Database } from '../db.ts';

export const TOKEN_DAYS = 90;

export async function sweepAffiliateTokens(db: Pick<Database, 'asSystem'>): Promise<number> {
  return db.asSystem(
    async q =>
      (
        await q.query(
          `DELETE FROM app.affiliate_click_tokens WHERE created_at < now() - make_interval(days => ${String(TOKEN_DAYS)})`,
        )
      ).rowCount ?? 0,
  );
}
