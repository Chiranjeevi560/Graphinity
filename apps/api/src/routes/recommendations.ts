import type { FastifyInstance } from 'fastify';
import type { Database } from '../db.ts';
import { rankRecommendations, type RecommendationRanks } from '../recommendation-ranking.ts';
import { signedIn } from './common.ts';

interface RecommendationRow {
  id: string;
  title: string;
  field: string;
  fieldName: string;
  answerCount: number;
  createdAt: Date;
  fieldRank: number | null;
  searchRank: number | null;
  readingRank: number | null;
  recentRank: number;
}

const VERSION = 'feed-rrf-v2';

/** Consent-aware, bounded, explainable knowledge recommendations; no commerce inputs. */
export function registerRecommendationRoutes(app: FastifyInstance, deps: { db: Database; enabled: () => boolean }) {
  app.get('/me/recommendations', { config: { auth: 'required' } }, async req => {
    const user = signedIn(req);
    if (!deps.enabled())
      return { enabled: false, availability: 'unavailable', algorithmVersion: VERSION, recommendations: [] };
    return deps.db.withUser(user.id, async q => {
      const choices = await q.query<{ category: string; enabled: boolean }>(
        `SELECT c.name AS category, COALESCE(s.enabled, false) AS enabled
         FROM app.consent_categories c
         LEFT JOIN app.user_consent_settings s ON s.user_id = $1 AND s.category = c.name
         WHERE c.name = ANY($2::text[])`,
        [user.id, ['feed_personalization', 'search_history', 'reading_history']],
      );
      const enabled = new Map(choices.rows.map(row => [row.category, row.enabled]));
      if (!enabled.get('feed_personalization'))
        return { enabled: false, availability: 'consent_required', algorithmVersion: VERSION, recommendations: [] };

      const recommendations = await q.query<RecommendationRow>(
        `WITH active_events AS MATERIALIZED (
           SELECT e.consent_category, e.signal_type, e.value, e.subject_id, e.occurred_at
           FROM app.personal_signal_events e
           WHERE e.user_id = $1 AND e.expires_at > now()
             AND ((e.consent_category = 'search_history' AND $2::boolean
                   AND e.signal_type = 'question_precheck')
               OR (e.consent_category = 'reading_history' AND $3::boolean
                   AND e.signal_type = 'question_viewed'))
           ORDER BY e.occurred_at DESC LIMIT 50
         ),
         viewed AS MATERIALIZED (
           SELECT e.subject_id::bigint AS id, q.field, q.title, e.occurred_at
           FROM active_events e
           JOIN app.questions q ON q.id = e.subject_id::bigint
           WHERE e.consent_category = 'reading_history'
             AND NOT app.is_question_hidden(q.id)
         ),
         candidate_ids AS MATERIALIZED (
           SELECT field_candidates.id FROM (
             SELECT q.id
             FROM app.questions q
             JOIN app.profile_fields pf ON pf.profile_id = $1 AND pf.field = q.field
             WHERE q.created_at > now() - interval '180 days' AND NOT app.is_question_hidden(q.id)
             ORDER BY q.created_at DESC, q.id DESC LIMIT 100
           ) field_candidates
           UNION
           SELECT match.id
           FROM active_events e
           CROSS JOIN LATERAL (
             SELECT q.id
             FROM app.questions q
             WHERE e.consent_category = 'search_history'
               AND q.search @@ replace(plainto_tsquery('english', e.value ->> 'query')::text, ' & ', ' | ')::tsquery
               AND q.created_at > now() - interval '180 days'
               AND NOT app.is_question_hidden(q.id)
             ORDER BY ts_rank_cd(q.search, replace(plainto_tsquery('english', e.value ->> 'query')::text, ' & ', ' | ')::tsquery) DESC,
                      q.created_at DESC, q.id DESC LIMIT 20
           ) match
           UNION
           SELECT q.id
           FROM viewed v
           CROSS JOIN LATERAL (
             SELECT recent.id
             FROM app.questions recent
             WHERE recent.field = v.field AND recent.id <> v.id
               AND recent.created_at > now() - interval '180 days'
               AND NOT app.is_question_hidden(recent.id)
             ORDER BY recent.created_at DESC, recent.id DESC LIMIT 25
           ) q
           UNION
           SELECT recent_candidates.id FROM (
             SELECT q.id
             FROM app.questions q
             WHERE q.created_at > now() - interval '30 days'
               AND NOT app.is_question_hidden(q.id)
             ORDER BY q.created_at DESC, q.id DESC LIMIT 100
           ) recent_candidates
         ),
         eligible AS MATERIALIZED (
           SELECT q.id, q.title, q.field, f.name AS field_name, q.created_at,
                  (SELECT count(*)::int FROM app.answers a WHERE a.question_id = q.id) AS answer_count,
                  EXISTS (SELECT 1 FROM app.profile_fields pf WHERE pf.profile_id = $1 AND pf.field = q.field) AS field_match,
                  COALESCE((
                    SELECT max(ts_rank_cd(q.search, replace(plainto_tsquery('english', e.value ->> 'query')::text, ' & ', ' | ')::tsquery))
                    FROM active_events e
                    WHERE e.consent_category = 'search_history'
                      AND q.search @@ replace(plainto_tsquery('english', e.value ->> 'query')::text, ' & ', ' | ')::tsquery
                  ), 0.0) AS search_match,
                  COALESCE((
                    SELECT max(ts_rank_cd(q.search, replace(plainto_tsquery('english', v.title)::text, ' & ', ' | ')::tsquery))
                    FROM viewed v
                    WHERE q.search @@ replace(plainto_tsquery('english', v.title)::text, ' & ', ' | ')::tsquery
                  ), 0.0) AS reading_match
           FROM candidate_ids c
           JOIN app.questions q ON q.id = c.id
           JOIN app.fields f ON f.slug = q.field
           WHERE q.asker_id <> $1 AND NOT app.is_question_hidden(q.id)
             AND NOT EXISTS (SELECT 1 FROM app.answers a WHERE a.question_id = q.id AND a.answerer_id = $1)
             AND NOT EXISTS (SELECT 1 FROM viewed v WHERE v.id = q.id)
         ),
         ranked_sources AS (
           SELECT e.*,
                  CASE WHEN field_match THEN row_number() OVER (ORDER BY field_match DESC, created_at DESC, id DESC)::int END AS field_rank,
                  CASE WHEN search_match > 0 THEN row_number() OVER (ORDER BY search_match DESC, created_at DESC, id DESC)::int END AS search_rank,
                  CASE WHEN reading_match > 0 THEN row_number() OVER (ORDER BY reading_match DESC, created_at DESC, id DESC)::int END AS reading_rank,
                  row_number() OVER (ORDER BY created_at DESC, id DESC)::int AS recent_rank
           FROM eligible e
         )
         SELECT id::text, title, field, field_name AS "fieldName", answer_count AS "answerCount",
                created_at AS "createdAt", field_rank AS "fieldRank", search_rank AS "searchRank",
                reading_rank AS "readingRank", recent_rank AS "recentRank"
         FROM ranked_sources`,
        [user.id, enabled.get('search_history') === true, enabled.get('reading_history') === true],
      );
      const ranked = rankRecommendations(
        recommendations.rows.map(item => ({
          ...item,
          ranks: {
            field: item.fieldRank,
            search: item.searchRank,
            reading: item.readingRank,
            recent: item.recentRank,
          } satisfies RecommendationRanks,
        })),
        20,
      );
      return {
        enabled: true,
        algorithmVersion: VERSION,
        recommendations: ranked.map(({ item, score, reason }) => ({
          id: item.id,
          title: item.title,
          field: item.field,
          fieldName: item.fieldName,
          answerCount: item.answerCount,
          createdAt: item.createdAt,
          score: Number(score.toFixed(6)),
          reason,
        })),
      };
    });
  });
}
