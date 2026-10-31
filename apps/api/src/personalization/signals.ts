// The personal knowledge graph's signals (docs/adr/0025-personal-signals.md):
// the 31 kinds of thing a person did in Graphinity that can tell it what they
// know and care about. Nothing new is collected here. Each signal is read from
// the record the action already left, under the person's own row-level
// security, and only summarised: how many, how recent, and how much evidence
// is left after decay. Rows never leave the database, so the summary costs one
// query however long the history.
//
// Evidence decays exponentially, each signal at its own half-life: e = Σ 2^(-age/h).
// Confidence is the mean of a Beta(e, κ) posterior, e / (e + κ): a prior worth
// κ observations against the signal, so one old action is weak evidence and
// many recent ones are strong, and it never reaches 1.
import type { Queryable } from '../db.ts';

/**
 * Why Graphinity may hold a signal: `account` is what running the service needs,
 * `per_item` means each item carries the category chosen when it was added,
 * anything else is the consent category of that name.
 */
export type SignalBasis = string;

export interface SignalDefinition {
  name: string;
  /** In plain words, for the person's own page. */
  label: string;
  basis: SignalBasis;
  halfLifeDays: number;
  /** κ: how many observations it takes to reach a confidence of one half. */
  prior: number;
  /** A SELECT with one column, `at`, for this person ($1). */
  sql: string;
}

const own = (table: string, at: string, column = 'user_id', extra = '') =>
  `SELECT ${at} AS at FROM app.${table} WHERE ${column} = $1${extra}`;
const event = (category: string, type: string) =>
  own(
    'personal_signal_events',
    'occurred_at',
    'user_id',
    ` AND consent_category = '${category}' AND signal_type = '${type}'`,
  );
/** Marks on answers to the person's questions: what they gave. */
const onMyQuestions = (table: string, at: string, extra = '') =>
  `SELECT m.${at} AS at FROM app.${table} m JOIN app.answers a ON a.id = m.answer_id
   JOIN app.questions q ON q.id = a.question_id WHERE q.asker_id = $1${extra}`;
/** Marks on the person's answers: what they received. */
const onMyAnswers = (table: string, at: string, extra = '') =>
  `SELECT m.${at} AS at FROM app.${table} m JOIN app.answers a ON a.id = m.answer_id WHERE a.answerer_id = $1${extra}`;

export const SIGNALS: readonly SignalDefinition[] = [
  // Asking.
  {
    name: 'question_asked',
    label: 'Questions you asked',
    basis: 'account',
    halfLifeDays: 180,
    prior: 2,
    sql: own('questions', 'created_at', 'asker_id'),
  },
  {
    name: 'answer_received',
    label: 'Answers to your questions',
    basis: 'account',
    halfLifeDays: 90,
    prior: 3,
    sql: `SELECT a.created_at AS at FROM app.answers a JOIN app.questions q ON q.id = a.question_id WHERE q.asker_id = $1`,
  },
  {
    name: 'pick_given',
    label: 'Answers you picked',
    basis: 'account',
    halfLifeDays: 180,
    prior: 2,
    sql: `SELECT s.selected_at AS at FROM app.selections s JOIN app.questions q ON q.id = s.question_id WHERE q.asker_id = $1 AND s.answer_id IS NOT NULL`,
  },
  {
    name: 'pick_changed',
    label: 'Picks you changed',
    basis: 'account',
    halfLifeDays: 90,
    prior: 2,
    sql: `SELECT s.selected_at AS at FROM app.selections s JOIN app.questions q ON q.id = s.question_id WHERE q.asker_id = $1 AND s.changes > 0`,
  },
  {
    name: 'helpful_given',
    label: 'Answers you marked helpful',
    basis: 'account',
    halfLifeDays: 180,
    prior: 2,
    sql: onMyQuestions('helpful_marks', 'marked_at'),
  },
  {
    name: 'rating_given',
    label: 'Answers you rated',
    basis: 'account',
    halfLifeDays: 180,
    prior: 2,
    sql: onMyQuestions('ratings', 'at'),
  },
  {
    name: 'verdict_given',
    label: 'Answers you said turned out right or wrong',
    basis: 'account',
    halfLifeDays: 365,
    prior: 2,
    sql: onMyQuestions('verdicts', 'at'),
  },
  // Answering.
  {
    name: 'answer_written',
    label: 'Answers you wrote',
    basis: 'account',
    halfLifeDays: 365,
    prior: 3,
    sql: own('answers', 'created_at', 'answerer_id'),
  },
  {
    name: 'pick_received',
    label: 'Your answers people picked',
    basis: 'account',
    halfLifeDays: 365,
    prior: 2,
    sql: `SELECT s.selected_at AS at FROM app.selections s JOIN app.answers a ON a.id = s.answer_id WHERE a.answerer_id = $1`,
  },
  {
    name: 'helpful_received',
    label: 'Your answers marked helpful',
    basis: 'account',
    halfLifeDays: 365,
    prior: 2,
    sql: onMyAnswers('helpful_marks', 'marked_at'),
  },
  {
    name: 'rating_received',
    label: 'Ratings on your answers',
    basis: 'account',
    halfLifeDays: 365,
    prior: 3,
    sql: onMyAnswers('ratings', 'at'),
  },
  {
    name: 'verdict_received',
    label: 'Your answers that turned out right',
    basis: 'account',
    halfLifeDays: 730,
    prior: 2,
    sql: onMyAnswers('verdicts', 'at', ' AND m.correct'),
  },
  {
    name: 'question_routed',
    label: 'Questions sent to you',
    basis: 'account',
    halfLifeDays: 60,
    prior: 5,
    sql: own('routes', 'routed_at', 'profile_id'),
  },
  {
    name: 'route_seen',
    label: 'Sent questions you opened',
    basis: 'account',
    halfLifeDays: 60,
    prior: 5,
    sql: own('routes', 'seen_at', 'profile_id', ' AND seen_at IS NOT NULL'),
  },
  {
    name: 'route_answered',
    label: 'Sent questions you answered',
    basis: 'account',
    halfLifeDays: 90,
    prior: 3,
    sql: `SELECT a.created_at AS at FROM app.routes r JOIN app.answers a ON a.question_id = r.question_id AND a.answerer_id = r.profile_id WHERE r.profile_id = $1`,
  },
  {
    name: 'route_passed',
    label: 'Sent questions you passed on',
    basis: 'account',
    halfLifeDays: 60,
    prior: 3,
    sql: own('route_passes', 'passed_at', 'profile_id', ' AND undone_at IS NULL'),
  },
  // Your reading and searching, each under its own choice.
  {
    name: 'question_viewed',
    label: 'Questions you opened',
    basis: 'reading_history',
    halfLifeDays: 30,
    prior: 3,
    sql: event('reading_history', 'question_viewed'),
  },
  {
    name: 'search',
    label: 'Searches you made',
    basis: 'search_history',
    halfLifeDays: 30,
    prior: 3,
    sql: event('search_history', 'search'),
  },
  {
    name: 'question_precheck',
    label: 'Questions you started typing',
    basis: 'search_history',
    halfLifeDays: 30,
    prior: 3,
    sql: event('search_history', 'question_precheck'),
  },
  {
    name: 'search_logged',
    label: 'Searches kept to improve search',
    basis: 'search_improvement',
    halfLifeDays: 90,
    prior: 5,
    sql: own('searches', 'created_at'),
  },
  {
    name: 'search_opened',
    label: 'Search results you opened',
    basis: 'search_improvement',
    halfLifeDays: 90,
    prior: 3,
    sql: `SELECT o.opened_at AS at FROM app.search_opens o JOIN app.searches s ON s.id = o.search_id WHERE s.user_id = $1`,
  },
  {
    name: 'search_read',
    label: 'Search results you read for a while',
    basis: 'search_improvement',
    halfLifeDays: 90,
    prior: 2,
    sql: `SELECT o.opened_at AS at FROM app.search_opens o JOIN app.searches s ON s.id = o.search_id WHERE s.user_id = $1 AND o.dwell_ms >= 30000`,
  },
  // What you told Graphinity.
  {
    name: 'field_selected',
    label: 'Topics you chose',
    basis: 'account',
    halfLifeDays: 3650,
    prior: 1,
    sql: `SELECT p.created_at AS at FROM app.profile_fields f JOIN app.profiles p ON p.id = f.profile_id WHERE f.profile_id = $1`,
  },
  {
    name: 'report_sent',
    label: 'Posts you reported',
    basis: 'account',
    halfLifeDays: 365,
    prior: 2,
    sql: own('reports', 'created_at', 'reporter_id'),
  },
  {
    name: 'device_added',
    label: 'Devices getting notifications',
    basis: 'account',
    halfLifeDays: 365,
    prior: 1,
    sql: own('push_subscriptions', 'created_at', 'profile_id'),
  },
  {
    name: 'item_recorded',
    label: 'Things you added to your graph',
    basis: 'per_item',
    halfLifeDays: 730,
    prior: 1,
    sql: own('personal_graph_nodes', 'created_at'),
  },
  {
    name: 'link_recorded',
    label: 'Links in your graph',
    basis: 'per_item',
    halfLifeDays: 365,
    prior: 2,
    sql: own('personal_graph_edges', 'created_at'),
  },
  {
    name: 'collection_created',
    label: 'Collections you made',
    basis: 'per_item',
    halfLifeDays: 365,
    prior: 1,
    sql: own('personal_collections', 'created_at'),
  },
  // What Graphinity remembers, only while you allow it.
  {
    name: 'memory_procedural',
    label: 'Preferences it remembers',
    basis: 'memory_personalization',
    halfLifeDays: 365,
    prior: 1,
    sql: own('memory_entries', 'seen_at', 'user_id', " AND tier = 'procedural'"),
  },
  {
    name: 'memory_semantic',
    label: 'Topics it remembers',
    basis: 'memory_personalization',
    halfLifeDays: 180,
    prior: 2,
    sql: own('memory_entries', 'seen_at', 'user_id', " AND tier = 'semantic'"),
  },
  {
    name: 'memory_episodic',
    label: 'Recent moments it remembers',
    basis: 'memory_personalization',
    halfLifeDays: 14,
    prior: 3,
    sql: own('memory_entries', 'seen_at', 'user_id', " AND tier = 'episodic'"),
  },
];

/** e / (e + κ): the mean of Beta(e, κ). 0 with no evidence, below 1 always. */
export function confidence(evidence: number, prior: number): number {
  return evidence > 0 ? evidence / (evidence + prior) : 0;
}

/** What 1 observation is worth after `ageDays`. Future times (clock skew) count as now. */
export function decayed(ageDays: number, halfLifeDays: number): number {
  return 2 ** (-Math.max(0, ageDays) / halfLifeDays);
}

export interface SignalSummary {
  name: string;
  label: string;
  basis: SignalBasis;
  count: number;
  lastAt: string | null;
  /** Decayed evidence, then its confidence; both rounded for display. */
  evidence: number;
  confidence: number;
}

/** Every signal, in catalogue order, for one person. Runs under their own row-level security. */
export async function loadSignals(q: Queryable, userId: string): Promise<SignalSummary[]> {
  const union = SIGNALS.map(
    (s, i) => `SELECT ${String(i)} AS i, count(*)::int AS n, max(at) AS last_at,
      coalesce(sum(power(2, -greatest(0, extract(epoch FROM now() - at)) / 86400 / ${String(s.halfLifeDays)})), 0)::float8 AS e
      FROM (${s.sql}) x`,
  ).join('\nUNION ALL\n');
  const { rows } = await q.query<{ i: number; n: number; last_at: Date | null; e: number }>(union, [userId]);
  const byIndex = new Map(rows.map(r => [r.i, r]));
  return SIGNALS.map((s, i) => {
    const r = byIndex.get(i);
    const evidence = r?.e ?? 0;
    return {
      name: s.name,
      label: s.label,
      basis: s.basis,
      count: r?.n ?? 0,
      lastAt: r?.last_at?.toISOString() ?? null,
      evidence: Math.round(evidence * 100) / 100,
      confidence: Math.round(confidence(evidence, s.prior) * 1000) / 1000,
    };
  });
}

/** Everything Graphinity stores under one consent category, for "forget this kind of thing". */
export async function purgeCategory(q: Queryable, userId: string, category: string): Promise<number> {
  const run = async (sql: string) => (await q.query(sql, [userId, category])).rowCount ?? 0;
  // Links first: removing a thing also removes its links, which would hide them from the count.
  let removed = await run('DELETE FROM app.personal_graph_edges WHERE user_id = $1 AND consent_category = $2');
  removed += await run('DELETE FROM app.personal_signal_events WHERE user_id = $1 AND consent_category = $2');
  removed += await run('DELETE FROM app.personal_collections WHERE user_id = $1 AND consent_category = $2');
  removed += await run('DELETE FROM app.personal_graph_nodes WHERE user_id = $1 AND consent_category = $2');
  if (category === 'memory_personalization')
    removed += (await q.query('DELETE FROM app.memory_entries WHERE user_id = $1', [userId])).rowCount ?? 0;
  if (category === 'search_improvement')
    removed += (await q.query('DELETE FROM app.searches WHERE user_id = $1', [userId])).rowCount ?? 0;
  return removed;
}
