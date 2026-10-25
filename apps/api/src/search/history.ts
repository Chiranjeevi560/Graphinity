// A person's own search history (consent "search_history", migration 0003):
// kept only while they allow it, for their own personalization, never for
// anyone else's. The consent is checked inside the insert, so a search made
// as it is turned off can't slip in between a check and a write.
import type { Database } from '../db.ts';

/** Where the search was made: the Ask screen's check, or the Search screen. */
export type SearchSource = 'question_precheck' | 'search';

export async function recordOwnSearch(
  db: Pick<Database, 'withUser'>,
  userId: string,
  source: SearchSource,
  query: string,
  field: string | null,
): Promise<void> {
  await db.withUser(userId, async q => {
    await q.query(
      `INSERT INTO app.personal_signal_events
         (user_id, consent_category, signal_type, value, source, expires_at)
       SELECT $1, 'search_history', $4, jsonb_build_object('query', $2::text, 'field', $3::text),
              'user_action', clock_timestamp() + interval '365 days'
       WHERE EXISTS (
         SELECT 1 FROM app.user_consent_settings s
         WHERE s.user_id = $1 AND s.category = 'search_history' AND s.enabled
       ) AND NOT EXISTS (
         -- A draft re-checked as it's typed is one search, not one per keystroke.
         SELECT 1 FROM app.personal_signal_events e
         WHERE e.user_id = $1 AND e.consent_category = 'search_history'
           AND e.signal_type = $4
           AND e.value = jsonb_build_object('query', $2::text, 'field', $3::text)
           AND e.occurred_at > clock_timestamp() - interval '5 minutes'
       )`,
      [userId, query, field, source],
    );
  });
}
