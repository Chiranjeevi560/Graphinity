// Finite, consented knowledge discovery, v3 (ADR 0016, after ADR 0006): at
// most 20 public questions for a signed-in person who turned on
// feed_personalization, each with the reason it is there. Candidates come
// from independent sources, each bounded and best first, fused by reciprocal
// rank (no hand-picked weights), then filtered: never their own, one they
// answered, one they opened, or a hidden one. No commercial input, and no
// recommendation is stored.
//
// v3's sources, each measured against v2 (scripts/benchmark-recommendations-v3.mjs):
// - search: the person's own recent searches (Search screen and Ask check),
//   through the search engine itself (BM25 and meaning), while search_history is on;
// - reading: questions nearest in meaning to ones they opened (by words while no
//   meaning model serves), while reading_history is on;
// - co_answer: questions answered by the same people as ones they opened
//   (public answers: item-to-item collaborative filtering), while reading_history is on;
// - field: recent questions in their profile fields;
// - recent: recent questions overall.
import type { Database, Queryable } from '../db.ts';
import type { SearchEngine } from '../search/engine.ts';
import { RRF_K } from '../precheck.ts';

export const FEED_VERSION = 'feed-rrf-v3';
export const FEED_SIZE = 20;
/** Own signals read per request, newest first: bounds the work whatever the history. */
export const RECENT_SEARCHES = 5;
export const RECENT_VIEWS = 5;
const PER_SEED = 20;
const SOURCE_CAP = 100;
/** Discovery is of current questions. */
export const MAX_AGE_DAYS = 180;

export type Source = 'search' | 'reading' | 'co_answer' | 'field' | 'recent';
export const ALL_SOURCES: readonly Source[] = ['search', 'reading', 'co_answer', 'field', 'recent'];
/**
 * Tiers, each filling only what the one before left, in order of measured
 * strength (ADR 0016, scripts/benchmark-recommendations-v3.mjs):
 * 1. the person's own searches, and what the same people answered;
 * 2. similar to what they opened: fused with tier 1 it lowered recall@20
 *    (by 0.021 by meaning, by 0.011 by words), but it is a better fill than
 *    3. their fields and recent questions, which fused with everything outvoted
 *    the personal sources (0.088 against 0.152), and still give someone with no
 *    history a full list.
 */
export const TIERS: ReadonlyArray<readonly Source[]> = [['search', 'co_answer'], ['reading'], ['field', 'recent']];

export const REASONS: Record<Source, string> = {
  search: 'Related to your recent Graphinity searches',
  reading: 'Similar to a question you opened',
  co_answer: 'Answered by people who answered one you opened',
  field: 'In one of your selected topics',
  recent: 'Recently asked in Graphinity',
};

export interface Recommendation {
  id: string;
  title: string;
  field: string;
  fieldName: string;
  answerCount: number;
  createdAt: Date;
  score: number;
  reason: string;
}

/** Round-robin merge of several best-first lists into one, first occurrence wins. */
export function interleaveLists(lists: readonly (readonly string[])[], cap = SOURCE_CAP): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; out.length < cap; i++) {
    let any = false;
    for (const list of lists) {
      const id = list[i];
      if (id === undefined) continue;
      any = true;
      if (!seen.has(id)) {
        seen.add(id);
        out.push(id);
        if (out.length >= cap) break;
      }
    }
    if (!any) break;
  }
  return out;
}

/** Reciprocal rank fusion across sources; the strongest contribution gives the reason. */
export function fuseSources(
  ranked: Partial<Record<Source, readonly string[]>>,
  sources: readonly Source[] = ALL_SOURCES,
): Array<{ id: string; score: number; source: Source }> {
  const score = new Map<string, { score: number; best: number; source: Source }>();
  for (const source of sources) {
    (ranked[source] ?? []).forEach((id, i) => {
      const contribution = 1 / (RRF_K + i + 1);
      const now = score.get(id) ?? { score: 0, best: 0, source };
      now.score += contribution;
      if (contribution > now.best) {
        now.best = contribution;
        now.source = source;
      }
      score.set(id, now);
    });
  }
  return [...score.entries()]
    .map(([id, v]) => ({ id, score: v.score, source: v.source }))
    .sort((a, b) => b.score - a.score || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

export async function recommend(
  deps: { db: Pick<Database, 'withUser'>; engine: SearchEngine; meaningModel: () => string | null },
  userId: string,
  sources: readonly Source[] = ALL_SOURCES,
): Promise<{ enabled: boolean; availability?: 'consent_required'; recommendations: Recommendation[] }> {
  const want = new Set(sources);
  const own = await deps.db.withUser(userId, async q => {
    const choices = await q.query<{ category: string; enabled: boolean }>(
      `SELECT c.name AS category, COALESCE(s.enabled, false) AS enabled
       FROM app.consent_categories c
       LEFT JOIN app.user_consent_settings s ON s.user_id = $1 AND s.category = c.name
       WHERE c.name = ANY($2::text[])`,
      [userId, ['feed_personalization', 'search_history', 'reading_history']],
    );
    const on = new Map(choices.rows.map(r => [r.category, r.enabled]));
    if (!on.get('feed_personalization')) return null;
    const signals = await q.query<{
      kind: 'search' | 'view';
      query: string | null;
      field: string | null;
      subject: string | null;
    }>(
      `SELECT CASE WHEN e.consent_category = 'search_history' THEN 'search' ELSE 'view' END AS kind,
              e.value ->> 'query' AS query, e.value ->> 'field' AS field, e.subject_id AS subject
       FROM app.personal_signal_events e
       WHERE e.user_id = $1 AND e.expires_at > now()
         AND ((e.consent_category = 'search_history' AND $2::boolean
               AND e.signal_type IN ('search', 'question_precheck'))
           OR (e.consent_category = 'reading_history' AND $3::boolean AND e.signal_type = 'question_viewed'))
       ORDER BY e.occurred_at DESC LIMIT 100`,
      [userId, on.get('search_history') === true, on.get('reading_history') === true],
    );
    return signals.rows;
  });
  if (own === null) return { enabled: false, availability: 'consent_required', recommendations: [] };

  const searches = distinct(
    own.filter(s => s.kind === 'search' && s.query).map(s => `${s.field ?? ''}\n${s.query ?? ''}`),
  ).slice(0, RECENT_SEARCHES);
  const viewed = distinct(
    own.filter(s => s.kind === 'view' && s.subject && /^[1-9][0-9]{0,15}$/.test(s.subject)).map(s => s.subject ?? ''),
  );
  const seeds = viewed.slice(0, RECENT_VIEWS);
  const model = deps.meaningModel();

  const ranked: Partial<Record<Source, string[]>> = {};
  if (want.has('search') && searches.length) {
    const lists: string[][] = [];
    for (const s of searches) {
      const [field, text] = [s.slice(0, s.indexOf('\n')) || null, s.slice(s.indexOf('\n') + 1)];
      const r = await deps.engine.retrieve({ text, field, pool: PER_SEED });
      lists.push(r.found.map(f => f.id));
    }
    ranked.search = interleaveLists(lists);
  }
  await deps.db.withUser(userId, async q => {
    if (want.has('reading') && seeds.length) ranked.reading = await similarTo(q, seeds, model);
    if (want.has('co_answer') && seeds.length) ranked.co_answer = await answeredTogether(q, seeds);
    if (want.has('field')) ranked.field = await inFields(q, userId);
    if (want.has('recent')) ranked.recent = await recent(q);
  });
  // Each tier fills only what the ones before it left.
  const taken = new Set<string>();
  const fused = TIERS.flatMap(tier =>
    fuseSources(ranked, tier).filter(f => {
      if (taken.has(f.id)) return false;
      taken.add(f.id);
      return true;
    }),
  );
  if (fused.length === 0) return { enabled: true, recommendations: [] };

  // What may be shown: current, visible, not their own, not answered or opened by them.
  const rows = await deps.db.withUser(
    userId,
    async q =>
      (
        await q.query<{
          id: string;
          title: string;
          field: string;
          field_name: string;
          answer_count: number;
          created_at: Date;
        }>(
          `SELECT q.id::text AS id, q.title, q.field, f.name AS field_name, q.created_at,
                (SELECT count(*)::int FROM app.answers a WHERE a.question_id = q.id) AS answer_count
         FROM app.questions q JOIN app.fields f ON f.slug = q.field
         WHERE q.id = ANY($2::bigint[])
           AND q.asker_id <> $1
           AND q.created_at > now() - make_interval(days => $4)
           AND NOT app.is_question_hidden(q.id)
           AND NOT EXISTS (SELECT 1 FROM app.answers a WHERE a.question_id = q.id AND a.answerer_id = $1)
           AND NOT (q.id::text = ANY($3::text[]))`,
          [userId, fused.slice(0, 500).map(f => f.id), viewed, MAX_AGE_DAYS],
        )
      ).rows,
  );
  const byId = new Map(rows.map(r => [r.id, r]));
  const recommendations = fused.flatMap((f): Recommendation[] => {
    const r = byId.get(f.id);
    return r
      ? [
          {
            id: r.id,
            title: r.title,
            field: r.field,
            fieldName: r.field_name,
            answerCount: r.answer_count,
            createdAt: r.created_at,
            score: Number(f.score.toFixed(6)),
            reason: REASONS[f.source],
          },
        ]
      : [];
  });
  return { enabled: true, recommendations: recommendations.slice(0, FEED_SIZE) };
}

function distinct(xs: readonly string[]): string[] {
  return [...new Set(xs)];
}

/**
 * Nearest in meaning to each opened question, merged round robin. Without a
 * meaning model (none serves yet, or it is switched off), the closest by
 * words instead: BM25 on the opened question's title.
 */
async function similarTo(q: Queryable, seeds: readonly string[], model: string | null): Promise<string[]> {
  const lists: string[][] = [];
  for (const seed of seeds) {
    const { rows } = model
      ? await q.query<{ id: string }>('SELECT id::text AS id FROM app.similar_questions($1, $2, $3)', [
          seed,
          model,
          PER_SEED,
        ])
      : await q.query<{ id: string }>(
          `SELECT w.id::text AS id FROM app.questions s
           CROSS JOIN LATERAL app.word_search(s.title, '{}', NULL, NULL, $2) w
           WHERE s.id = $1 AND w.id <> s.id`,
          [seed, PER_SEED + 1],
        );
    lists.push(rows.map(r => r.id));
  }
  return interleaveLists(lists);
}

/**
 * Questions answered by people who answered the opened ones, by how many
 * such people answered them (public answers only, as row-level security shows them).
 */
async function answeredTogether(q: Queryable, seeds: readonly string[]): Promise<string[]> {
  const { rows } = await q.query<{ id: string }>(
    `SELECT other.question_id::text AS id
     FROM app.answers seed
     JOIN app.answers other ON other.answerer_id = seed.answerer_id AND other.question_id <> seed.question_id
     WHERE seed.question_id = ANY($1::bigint[]) AND NOT (other.question_id = ANY($1::bigint[]))
     GROUP BY other.question_id
     ORDER BY count(DISTINCT other.answerer_id) DESC, other.question_id DESC
     LIMIT ${String(SOURCE_CAP)}`,
    [seeds],
  );
  return rows.map(r => r.id);
}

async function inFields(q: Queryable, userId: string): Promise<string[]> {
  const { rows } = await q.query<{ id: string }>(
    `SELECT q.id::text AS id FROM app.questions q
     JOIN app.profile_fields pf ON pf.profile_id = $1 AND pf.field = q.field
     WHERE q.created_at > now() - make_interval(days => $2)
     ORDER BY q.created_at DESC, q.id DESC LIMIT ${String(SOURCE_CAP)}`,
    [userId, MAX_AGE_DAYS],
  );
  return rows.map(r => r.id);
}

async function recent(q: Queryable): Promise<string[]> {
  const { rows } = await q.query<{ id: string }>(
    `SELECT q.id::text AS id FROM app.questions q
     WHERE q.created_at > now() - interval '30 days'
     ORDER BY q.created_at DESC, q.id DESC LIMIT ${String(SOURCE_CAP)}`,
  );
  return rows.map(r => r.id);
}
