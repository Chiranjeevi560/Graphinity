// Copies of removed posts last only as long as someone could still appeal (ADR 0027).
import type { Database } from '../db.ts';

export async function releaseExpiredHolds(db: Pick<Database, 'asSystem'>): Promise<number> {
  return db.asSystem(async q => {
    const { rowCount } = await q.query(
      `UPDATE app.legal_holds h SET released_at = clock_timestamp(), content = NULL
       WHERE h.released_at IS NULL AND h.release_after < clock_timestamp()
         AND NOT EXISTS (SELECT 1 FROM app.statements_of_reasons s
                         WHERE s.id = h.statement_id AND s.appeal_status = 'appealed')`,
    );
    return rowCount ?? 0;
  });
}
