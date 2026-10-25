// Putting a question to the people most likely to have done it, in staged
// waves (docs/SPEC.md §11.2): 5 people at once; 5 more at 20
// minutes if fewer than 3 of them have opened it or answered; 5 more at 60
// minutes while there's no consensus yet (fewer than 3 answers: consensus
// needs at least 3). Experts' attention is scarce: at most 3 a day each.
// The database (db/migrations, app.routes) enforces that limit and never
// routes to the asker.
import type { Database, Queryable } from './db.ts';
import type { Events } from './events.ts';
import { errorKind } from './jobs.ts';
import { replay } from './reputation.ts';
import { judgements } from './routes/points.ts';
import {
  ALPHA,
  affinityToSelected,
  circadianFit as countryCircadianFit,
  factorVector,
  FACTORS_VERSION,
  greedyDiverse,
  loadDampener,
  pageRank,
  psi,
  type Candidate,
} from './routing-score.ts';
import {
  decideLastPlace,
  NO_HISTORY,
  personHistory,
  seedFor,
  type ExploreCandidate,
  type ExploreDecision,
} from './ml/routing-bandit.ts';
import { loadHistories } from './ml/routing-data.ts';
import { scoreRoutingAt, type RoutingModel } from './ml/routing-model.ts';

/**
 * A promoted learned model (ADR 0013), when the owner has switched it on:
 * the chance this person gives an answer that helps, from their factors.
 * It ranks exploit places only; the newcomer place stays Ψ with its bonus.
 */
export interface Ranker {
  version: number;
  score(factors: readonly number[]): number;
  /** Its prediction for a route at a given wave (wave terms included): what calibration checks. */
  predicted(factors: readonly number[], wave: number): number;
}

/**
 * Exploration (ADR 0014), when the owner has switched it on and a routing
 * model serves: the last place of each wave goes to whoever the
 * uncertainty-aware procedure picks (routing-bandit.ts), instead of the
 * newcomer place.
 */
export interface Explorer {
  version: number;
  model: RoutingModel;
}

/** Minutes after asking. */
export const WAVES = [
  { wave: 1, size: 5, afterMinutes: 0 },
  { wave: 2, size: 5, afterMinutes: 20 },
  { wave: 3, size: 5, afterMinutes: 60 },
] as const;
/** Questions put to one person in any 24 hours (the database holds the same number). */
export const DAILY_LIMIT = 3;
/** Wave 2 waits while this many of those asked have opened it or answered. */
const ENGAGED_ENOUGH = 3;
/** Wave 3 waits once this many answers exist: enough for a consensus. */
const ANSWERS_FOR_CONSENSUS = 3;
/** Part of each wave kept for people who joined in the last two weeks. */
export const NEWCOMER_SHARE = 0.2;
/** Questions older than this are no longer routed further. */
const ROUTING_WINDOW = '1 day';

/** Why someone was asked, as it stood then: shown to them alone. */
export interface Reasons {
  sameCountry: boolean;
  fieldPoints: number;
  /** Null with nothing to go on yet. */
  trustPct: number | null;
  answeredPct: number | null;
  newcomer: boolean;
}

interface PoolRow {
  id: string;
  country_code: string;
  now_epoch: number;
  expertise_weight: number;
  same_country: boolean;
  picked_in_country: boolean;
  field_points: number;
  newcomer: boolean;
  asked: number;
  answered: number;
  trust_total: number;
  trust_correct: number;
  answers: number;
  picks: number;
  helped: number;
  median_reply: number | null;
  days_since_active: number | null;
  routes_in_field: number;
  used_today: number;
}

interface RankedCandidate extends Reasons {
  id: string;
  candidate: Candidate;
  score: number;
  explore: boolean;
  fieldRoutes: number;
}

/**
 * People for one wave, best first, by the spec's score Ψ (routing-score.ts).
 * Only people who list the question's field; never the asker, anyone
 * already asked, anyone who already answered, or anyone at today's limit.
 * The SQL gathers what each person did in this field; the score is worked
 * out here, where each part is tested on its own.
 */
async function candidates(
  q: Queryable,
  questionId: string,
  limit: number,
  newcomersOnly: boolean,
  ranker: Ranker | null,
): Promise<RankedCandidate[]> {
  if (limit <= 0) return [];
  await q.query(
    `INSERT INTO app.expertise_edge_weights (profile_id, field, country)
     SELECT p.id, t.field, COALESCE(t.country, p.country)
     FROM app.questions t
     JOIN app.profile_fields pf ON pf.field = t.field
     JOIN app.profiles p ON p.id = pf.profile_id
     WHERE t.id = $1 AND p.id <> t.asker_id
     ON CONFLICT (profile_id, field, country) DO NOTHING`,
    [questionId],
  );
  const pool = (
    await q.query<PoolRow>(
      `WITH target AS (SELECT id, asker_id, field, country FROM app.questions WHERE id = $1)
     SELECT p.id, p.country AS country_code, (extract(epoch FROM clock_timestamp()) * 1000)::float8 AS now_epoch,
            coalesce(ee.weight, 0.5)::float8 AS expertise_weight,
            coalesce(p.country = t.country, false) AS same_country,
            EXISTS (SELECT 1 FROM app.selections s JOIN app.answers a ON a.id = s.answer_id JOIN app.questions sq ON sq.id = s.question_id
                    WHERE a.answerer_id = p.id AND sq.field = t.field AND sq.country = t.country) AS picked_in_country,
            p.created_at > now() - interval '14 days' AS newcomer,
            coalesce((SELECT sum(l.amount) FROM app.points_ledger l WHERE l.recipient_id = p.id AND l.field = t.field), 0)::int AS field_points,
            asked.n AS asked, asked.answered,
            trust.total AS trust_total, trust.correct AS trust_correct,
            (SELECT count(*) FROM app.answers a JOIN app.questions aq ON aq.id = a.question_id
             WHERE a.answerer_id = p.id AND aq.field = t.field)::int AS answers,
            (SELECT count(*) FROM app.selections s JOIN app.answers a ON a.id = s.answer_id JOIN app.questions sq ON sq.id = s.question_id
             WHERE a.answerer_id = p.id AND sq.field = t.field)::int AS picks,
            (SELECT count(DISTINCT h.answer_id) FROM app.points_ledger h
             WHERE h.recipient_id = p.id AND h.field = t.field AND h.amount > 0 AND h.reason IN ('selected', 'helpful')
               AND NOT EXISTS (SELECT 1 FROM app.points_ledger x WHERE x.reverses = h.id))::int AS helped,
            -- How long they took to answer what was put to them, middle value.
            (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM a.created_at - r.routed_at))
             FROM app.routes r JOIN app.answers a ON a.question_id = r.question_id AND a.answerer_id = r.profile_id
             WHERE r.profile_id = p.id)::float8 AS median_reply,
            (extract(epoch FROM now() - greatest(
              (SELECT max(a.created_at) FROM app.answers a WHERE a.answerer_id = p.id),
              (SELECT max(aq.created_at) FROM app.questions aq WHERE aq.asker_id = p.id),
              (SELECT max(r.seen_at) FROM app.routes r WHERE r.profile_id = p.id))) / 86400)::float8 AS days_since_active,
            (SELECT count(*) FROM app.routes r JOIN app.questions rq ON rq.id = r.question_id
             WHERE r.profile_id = p.id AND rq.field = t.field)::int AS routes_in_field,
            (SELECT count(*) FROM app.routes r
             WHERE r.profile_id = p.id AND r.routed_at > clock_timestamp() - interval '1 day')::int AS used_today
     FROM app.profiles p
     JOIN target t ON true
     JOIN app.profile_fields pf ON pf.profile_id = p.id AND pf.field = t.field
     LEFT JOIN app.expertise_edge_weights ee
       ON ee.profile_id = p.id AND ee.field = t.field AND ee.country = COALESCE(t.country, p.country)
     -- Questions put to them in the last 60 days, and how many they
     -- answered. One sent in the last day counts only once answered: they
     -- still have time. A removed answer doesn't count as answering (row-level
     -- security hides it from this job, as from everyone but its author).
     CROSS JOIN LATERAL (
       SELECT count(*)::int AS n, count(*) FILTER (WHERE did.answered)::int AS answered
       FROM app.routes r
       CROSS JOIN LATERAL (SELECT EXISTS (
         SELECT 1 FROM app.answers a WHERE a.question_id = r.question_id AND a.answerer_id = p.id) AS answered) did
       WHERE r.profile_id = p.id AND r.routed_at > now() - interval '60 days'
         AND (r.routed_at < now() - interval '1 day' OR did.answered)
     ) asked
     -- Each asker counts once, with their latest word: as on profiles, but only this field.
     CROSS JOIN LATERAL (
       SELECT count(*)::int AS total, count(*) FILTER (WHERE latest.correct)::int AS correct
       FROM (SELECT DISTINCT ON (fq.asker_id) v.correct
             FROM app.verdicts v
             JOIN app.answers a ON a.id = v.answer_id
             JOIN app.questions fq ON fq.id = a.question_id
             WHERE a.answerer_id = p.id AND fq.field = t.field
             ORDER BY fq.asker_id, v.at DESC) latest
     ) trust
     WHERE p.id <> t.asker_id
       AND NOT EXISTS (SELECT 1 FROM app.routes r WHERE r.question_id = t.id AND r.profile_id = p.id)
       AND NOT EXISTS (SELECT 1 FROM app.answers a WHERE a.question_id = t.id AND a.answerer_id = p.id)
       AND (NOT $2::boolean OR p.created_at > now() - interval '14 days')
       -- Already at today's limit: the database would skip them, wasting the place.
       AND (SELECT count(*) FROM app.routes r
            WHERE r.profile_id = p.id AND r.routed_at > clock_timestamp() - interval '1 day') < ${String(DAILY_LIMIT)}`,
      [questionId, newcomersOnly],
    )
  ).rows;
  if (pool.length === 0) return [];
  const people = pool.map(r => r.id);

  const field = (
    await q.query<{ field: string; routes: number }>(
      `SELECT t.field, (SELECT count(*) FROM app.routes r JOIN app.questions rq ON rq.id = r.question_id WHERE rq.field = t.field)::int AS routes
     FROM app.questions t WHERE t.id = $1`,
      [questionId],
    )
  ).rows[0];
  if (!field) return [];
  const proximity = new Map(
    (
      await q.query<{ profile_id: string; proximity: number }>(
        'SELECT profile_id, proximity FROM app.experience_proximity($1, $2::uuid[])',
        [questionId, people],
      )
    ).rows.map(r => [r.profile_id, r.proximity]),
  );
  const games = await judgements(q, people, field.field);
  // Who picked whose answers in this field, and who is trusted to start from.
  const picks = (
    await q.query<{ asker: string; answerer: string }>(
      `SELECT sq.asker_id AS asker, a.answerer_id AS answerer
     FROM app.selections s JOIN app.answers a ON a.id = s.answer_id JOIN app.questions sq ON sq.id = s.question_id
     WHERE sq.field = $1`,
      [field.field],
    )
  ).rows;
  const moderators = (await q.query<{ id: string }>('SELECT profile_id AS id FROM app.moderators')).rows.map(r => r.id);
  const everyone = [...new Set([...people, ...moderators, ...picks.flatMap(p => [p.asker, p.answerer])])];
  const trust = pageRank(
    everyone,
    picks.map(p => [p.asker, p.answerer] as const),
    moderators,
  );

  const scored = pool.map(r => {
    const candidate: Candidate = {
      proximity: proximity.get(r.id) ?? null,
      skill: replay(games.get(r.id)?.get(field.field) ?? []),
      expertiseWeight: r.expertise_weight,
      resident: r.same_country,
      pickedInCountry: r.picked_in_country,
      trust: trust.get(r.id) ?? 0,
      helped: r.helped,
      answers: r.answers,
      picks: r.picks,
      medianReplySeconds: r.median_reply,
      asked: r.asked,
      answered: r.answered,
      daysSinceActive: r.days_since_active,
      routesInField: r.routes_in_field,
      usedToday: r.used_today,
      circadianFit: countryCircadianFit(r.country_code, new Date(r.now_epoch)),
      maxAffinityWithSelected: 1,
    };
    // The whole eligible pool is ranked here, by the learned model when one serves: it isn't
    // limited to re-ordering Ψ's favourites. Diversity starts at 1 (no one chosen yet).
    const score =
      ranker && !newcomersOnly
        ? r.used_today >= DAILY_LIMIT
          ? 0
          : ranker.score(factorVector(candidate, 1)) * loadDampener(r.used_today, DAILY_LIMIT)
        : psi(candidate, { routes: field.routes, dailyLimit: DAILY_LIMIT }, { explore: newcomersOnly });
    return { row: r, candidate, score };
  });
  // Best first; equal scores in a stable order, so the same facts give the same wave.
  scored.sort((a, b) => b.score - a.score || (a.row.id < b.row.id ? -1 : 1));
  const pct = (part: number, whole: number) => (whole > 0 ? Math.round((100 * part) / whole) : null);
  return scored.slice(0, limit).map(({ row: r, candidate, score }) => ({
    id: r.id,
    candidate,
    score,
    explore: newcomersOnly,
    fieldRoutes: field.routes,
    sameCountry: r.same_country,
    fieldPoints: r.field_points,
    trustPct: pct(r.trust_correct, r.trust_total),
    answeredPct: pct(r.answered, r.asked),
    newcomer: r.newcomer,
  }));
}

/**
 * The last place under exploration: exploitation's own choice for it, then
 * the uncertainty-aware decision between that person and everyone else
 * still eligible (newcomers included). Null when there's no one left.
 */
async function explorePlace(
  q: Queryable,
  questionId: string,
  wave: number,
  explorer: Explorer,
  picked: readonly RankedCandidate[],
  pool: readonly RankedCandidate[],
  affinities: ReadonlyMap<string, number>,
  learnedScore: ((person: RankedCandidate, maxAffinity: number) => number) | undefined,
): Promise<{ person: RankedCandidate; decision: ExploreDecision; greedy: RankedCandidate } | null> {
  const selected = picked.map(p => p.id);
  const remaining = pool.filter(p => !selected.includes(p.id) && p.candidate.usedToday < DAILY_LIMIT);
  const greedy = greedyDiverse(
    remaining.filter(p => !p.explore),
    1,
    affinities,
    selected,
    DAILY_LIMIT,
    learnedScore,
  )[0];
  if (!greedy) return null;
  const others = remaining.filter(p => p.id !== greedy.id);
  const explored = new Map(
    (
      await q.query<{ profile_id: string; n: number }>(
        `SELECT profile_id::text AS profile_id, count(*)::int AS n FROM app.route_factors
         WHERE profile_id = ANY($1::uuid[]) AND explore_reason = 'explored' AND recorded_at > now() - interval '7 days'
         GROUP BY profile_id`,
        [remaining.map(p => p.id)],
      )
    ).rows.map(r => [r.profile_id, r.n]),
  );
  const histories = await loadHistories(
    q,
    remaining.map(p => p.id),
  );
  const asCandidate = (p: RankedCandidate): ExploreCandidate => {
    const past = histories.get(p.id);
    return {
      id: p.id,
      factors: factorVector(p.candidate, 1 - affinityToSelected(p.id, selected, affinities)),
      history: past ? personHistory(explorer.model, past) : NO_HISTORY,
      exploredThisWeek: explored.get(p.id) ?? 0,
    };
  };
  const decision = decideLastPlace(
    explorer.model,
    asCandidate(greedy),
    others.map(asCandidate),
    seedFor(questionId, wave, explorer.version),
  );
  const person = remaining.find(p => p.id === decision.id) ?? greedy;
  return { person, decision, greedy };
}

/**
 * Routes one wave of a question. Returns the people actually asked (the
 * daily budget may skip some). One place in five goes to a newcomer, the
 * spec's "4 exploit + 1 explore".
 */
export async function routeWave(
  q: Queryable,
  questionId: string,
  wave: number,
  size: number,
  ranker: Ranker | null = null,
  explorer: Explorer | null = null,
): Promise<string[]> {
  const exploreCount = Math.ceil(size * NEWCOMER_SHARE);
  const newcomers = await candidates(q, questionId, Math.max(1, exploreCount) * 5, true, null);
  const rest = await candidates(q, questionId, size * 5, false, ranker);
  const pool = [...new Map([...newcomers, ...rest].map(person => [person.id, person])).values()];
  const ids = pool.map(person => person.id);
  const questionField = (
    await q.query<{ field: string }>('SELECT field FROM app.questions WHERE id = $1', [questionId])
  ).rows[0]?.field;
  const affinityRows = questionField
    ? (
        await q.query<{ user_low: string; user_high: string; weight: number }>(
          `SELECT user_low, user_high, weight FROM app.epistemic_affinity_edges
           WHERE field = $1 AND user_low = ANY($2::uuid[]) AND user_high = ANY($2::uuid[])`,
          [questionField, ids],
        )
      ).rows
    : [];
  const affinities = new Map(affinityRows.map(edge => [`${edge.user_low}:${edge.user_high}`, edge.weight]));
  // With exploration, newcomers have no reserved place: they compete for the last place on how
  // much there is to learn about them, like anyone else.
  const explorePicks = explorer ? [] : greedyDiverse(newcomers, exploreCount, affinities, [], DAILY_LIMIT);
  const selectedIds = explorePicks.map(person => person.id);
  const exploitPool = rest.filter(person => !selectedIds.includes(person.id));
  const learnedScore = (person: RankedCandidate, maxAffinity: number) =>
    ranker
      ? ranker.score(factorVector(person.candidate, 1 - maxAffinity)) *
        loadDampener(person.candidate.usedToday, DAILY_LIMIT)
      : 0;
  const exploitPicks = greedyDiverse(
    exploitPool,
    size - (explorer ? exploreCount : selectedIds.length),
    affinities,
    selectedIds,
    DAILY_LIMIT,
    ranker ? learnedScore : undefined,
  );
  const decided = explorer
    ? await explorePlace(
        q,
        questionId,
        wave,
        explorer,
        exploitPicks,
        pool,
        affinities,
        ranker ? learnedScore : undefined,
      )
    : null;
  const chosen = [...explorePicks, ...exploitPicks, ...(decided ? [decided.person] : [])];
  /** What gets stored for one person, given who was chosen before them and how their place was decided. */
  const rowFor = (person: RankedCandidate, before: readonly string[], decision: ExploreDecision | null) => {
    const diversity = 1 - affinityToSelected(person.id, before, affinities);
    const dampener = loadDampener(person.candidate.usedToday, DAILY_LIMIT);
    const learnedBy = person.explore ? null : ranker;
    const factors = factorVector(person.candidate, diversity);
    return {
      id: person.id,
      sameCountry: person.sameCountry,
      fieldPoints: person.fieldPoints,
      trustPct: person.trustPct,
      answeredPct: person.answeredPct,
      newcomer: person.newcomer,
      rankingScore: decision
        ? decision.mean
        : learnedBy
          ? learnedScore(person, 1 - diversity)
          : person.score + ALPHA.diversity * diversity * dampener,
      expertiseWeight: person.candidate.expertiseWeight,
      circadianFit: person.candidate.circadianFit,
      diversityFit: diversity,
      factors,
      explore: decision ? false : person.explore,
      modelVersion: decision && explorer ? explorer.version : learnedBy ? learnedBy.version : null,
      // The model's own prediction at this route's wave (no person effect): what calibration checks.
      predicted:
        decision && explorer
          ? scoreRoutingAt(explorer.model, factors, wave)
          : learnedBy
            ? learnedBy.predicted(factors, wave)
            : null,
      decision,
    };
  };
  let selectedBefore: string[] = [];
  const people = chosen.map(person => {
    // This person's place was decided by exploration (and how), or null.
    const decision = decided && decided.person.id === person.id ? decided.decision : null;
    const row = rowFor(person, selectedBefore, decision);
    selectedBefore = [...selectedBefore, person.id];
    return row;
  });
  // If the database refuses an exploration (its weekly cap, raced by another server), the place
  // goes to exploitation's choice instead, as if exploration had decided against it.
  const fallback = decided?.decision.explored
    ? rowFor(
        decided.greedy,
        exploitPicks.map(p => p.id),
        null,
      )
    : null;
  const asked: string[] = [];
  const insert = async (p: (typeof people)[number]) => {
    const res = await q.query(
      `INSERT INTO app.routes (question_id, profile_id, wave, same_country, field_points, trust_pct, answered_pct, newcomer,
                               ranking_score, expertise_weight, circadian_fit, diversity_fit, ranking_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) ON CONFLICT DO NOTHING`,
      [
        questionId,
        p.id,
        wave,
        p.sameCountry,
        p.fieldPoints,
        p.trustPct,
        p.answeredPct,
        p.newcomer,
        p.rankingScore,
        p.expertiseWeight,
        p.circadianFit,
        p.diversityFit,
        p.modelVersion === null ? 1 : 2,
      ],
    );
    if (res.rowCount) {
      // What this decision saw, for learning from its outcome (system-only; migration 0016).
      await q.query(
        `INSERT INTO app.route_factors (question_id, profile_id, factors_version, factors, explore, wave, model_version,
                                        predicted, explore_reason, propensity, probability_better)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          questionId,
          p.id,
          FACTORS_VERSION,
          p.factors,
          p.explore,
          wave,
          p.modelVersion,
          p.predicted,
          p.decision?.reason ?? null,
          p.decision?.propensity ?? null,
          p.decision?.probabilityBetter ?? null,
        ],
      );
      asked.push(p.id);
    }
  };
  for (const p of people) {
    if (!p.decision?.explored) {
      await insert(p);
      continue;
    }
    await q.query('SAVEPOINT exploration');
    try {
      await insert(p);
      await q.query('RELEASE SAVEPOINT exploration');
    } catch (err) {
      if (pgCode(err) !== '23514' || !fallback) throw err;
      await q.query('ROLLBACK TO SAVEPOINT exploration');
      await insert(fallback);
    }
  }
  return asked;
}

/** A Postgres error's SQLSTATE, if it is one. */
function pgCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err && typeof err.code === 'string'
    ? err.code
    : undefined;
}

/**
 * Sends every question that is due its next wave: no wave yet (a missed
 * first one); wave 2 from 20 minutes after asking, only if fewer than 3 of
 * those asked have opened it or answered; wave 3 from 60 minutes, only
 * while it has fewer than 3 answers. Returns what was routed, for the
 * caller to notify.
 */
export async function routeDueQuestions(
  db: Database,
  log?: { warn(obj: object, msg: string): void },
  /** The learned ranker to use now, or null for Ψ (asked once per run, so a switch flip applies at the next run). */
  ranker: () => Ranker | null = () => null,
  /** Exploration for the last place, or null for the newcomer place (asked once per run, like the ranker). */
  explorer: () => Explorer | null = () => null,
): Promise<Array<{ questionId: string; askerId: string; asked: string[] }>> {
  const current = ranker();
  const exploring = explorer();
  const due = await db.asSystem(async q => {
    const { rows } = await q.query<{
      id: string;
      asker_id: string;
      wave: number | null;
      age_minutes: number;
      engaged: number;
      answers: number;
    }>(
      `SELECT q.id::text AS id, q.asker_id, max(r.wave) AS wave,
              extract(epoch FROM clock_timestamp() - q.created_at) / 60 AS age_minutes,
              count(r.profile_id) FILTER (WHERE r.seen_at IS NOT NULL
                OR EXISTS (SELECT 1 FROM app.answers a WHERE a.question_id = q.id AND a.answerer_id = r.profile_id))::int AS engaged,
              (SELECT count(*) FROM app.answers a WHERE a.question_id = q.id)::int AS answers
       FROM app.questions q LEFT JOIN app.routes r ON r.question_id = q.id
       WHERE q.created_at > now() - interval '${ROUTING_WINDOW}'
       GROUP BY q.id`,
    );
    const waves: Array<{ questionId: string; askerId: string; wave: number; size: number }> = [];
    for (const row of rows) {
      const next = row.wave === null ? WAVES[0] : WAVES.find(w => w.wave === (row.wave ?? 0) + 1);
      if (!next || row.age_minutes < next.afterMinutes) continue;
      if (next.wave === 2 && row.engaged >= ENGAGED_ENOUGH) continue;
      if (next.wave === 3 && row.answers >= ANSWERS_FOR_CONSENSUS) continue;
      waves.push({ questionId: row.id, askerId: row.asker_id, wave: next.wave, size: next.size });
    }
    return waves;
  });
  // Each question in its own transaction: one slow or failing question
  // doesn't undo everyone else's routing.
  const routed: Array<{ questionId: string; askerId: string; asked: string[] }> = [];
  for (const w of due) {
    try {
      routed.push({
        questionId: w.questionId,
        askerId: w.askerId,
        asked: await db.asSystem(q => routeWave(q, w.questionId, w.wave, w.size, current, exploring)),
      });
    } catch (err) {
      log?.warn({ kind: errorKind(err) }, 'routing a question failed');
    }
  }
  return routed;
}

/**
 * Tells each person asked that a question is waiting for them, and the asker
 * that their question went out (their open page shows it travel).
 */
export function announceRouting(
  events: Pick<Events, 'publish'>,
  results: Array<{ questionId: string; askerId: string; asked: string[] }>,
): void {
  for (const { questionId, askerId, asked } of results) {
    for (const person of asked) events.publish(person, { type: 'routed', questionId });
    if (asked.length) events.publish(askerId, { type: 'sent', questionId });
  }
}
