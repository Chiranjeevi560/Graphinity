// The platform's background work: draining the journal into cubes, products and their demand,
// the knowledge graph and its embeddings, the feature store, budget pacing, experiments and the
// audit chain. Every job is bounded, idempotent and works through the database as the system.
import { createHmac } from 'node:crypto';
import type { Database, Queryable } from '../db.ts';
import { INITIAL_PACER, stepPacer, targetShare, trafficCurve } from '../ads/pacing.ts';
import { cellUniform, laplace } from '../ads/privacy.ts';
import { extractProducts, resolveEntities } from '../commerce/entity.ts';
import { forecastWithIntervals } from '../commerce/forecast.ts';
import { evaluate } from '../experiments/stats.ts';
import { appendEntry, verifyChain, type AuditEntry } from '../governance/audit-chain.ts';
import { buildGraph, embed, initSage, type GraphEdge } from '../kg/graphsage.ts';
import { CountMinSketch, HyperLogLog } from '../olap/sketches.ts';

const BATCH = 5_000;
export const MIN_CONTRIBUTORS = 25;
const DIMS = 64;

/** A subject's hash for one day only: sketches can't follow anyone from day to day. */
const dailyHash = (secret: Buffer, subject: string, day: string) =>
  createHmac('sha256', secret).update(`${day}\u0000${subject}`).digest('base64url');

/** Moves journal rows into the daily cube and deletes them. Returns how many were drained. */
export async function drainJournal(db: Pick<Database, 'asSystem'>, secret: Buffer): Promise<number> {
  return db.asSystem(async q => {
    await q.query("SELECT pg_advisory_xact_lock(hashtext('olap-journal'))");
    const { rows } = await q.query<{
      id: string;
      kind: string;
      field: string | null;
      country: string | null;
      subject: string | null;
      day: string;
    }>(
      `SELECT id::text, kind, field, country, subject::text, to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day
       FROM app.analytics_event_journal j ORDER BY j.id LIMIT $1`,
      [BATCH],
    );
    const cells = new Map<string, typeof rows>();
    for (const r of rows) {
      const k = `${r.day}|${r.field ?? '-'}|${r.country ?? '--'}`;
      cells.set(k, [...(cells.get(k) ?? []), r]);
    }
    for (const [k, list] of cells) {
      const [day = '', field = '', country = ''] = k.split('|');
      const old = (
        await q.query<{ hll: Buffer; cms: Buffer }>(
          `SELECT hll_unique_users AS hll, cms_top_entities AS cms FROM app.olap_daily_platform_cube
           WHERE day = $1 AND field_id = $2 AND country_iso = $3`,
          [day, field, country],
        )
      ).rows[0];
      const hll = old ? HyperLogLog.fromBytes(old.hll) : new HyperLogLog();
      const cms = old ? CountMinSketch.fromBytes(old.cms) : new CountMinSketch(256, 4);
      for (const r of list) {
        if (r.subject) hll.add(dailyHash(secret, r.subject, day));
        cms.add(r.kind);
      }
      const questions = list.filter(r => r.kind === 'question').length;
      await q.query(
        `INSERT INTO app.olap_daily_platform_cube (day, field_id, country_iso, events, questions, answers, hll_unique_users, cms_top_entities)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (day, field_id, country_iso) DO UPDATE SET
           events = app.olap_daily_platform_cube.events + excluded.events,
           questions = app.olap_daily_platform_cube.questions + excluded.questions,
           answers = app.olap_daily_platform_cube.answers + excluded.answers,
           hll_unique_users = excluded.hll_unique_users, cms_top_entities = excluded.cms_top_entities`,
        [day, field, country, list.length, questions, list.length - questions, hll.toBytes(), cms.toBytes()],
      );
    }
    if (rows.length) await q.query('DELETE FROM app.analytics_event_journal WHERE id <= $1', [rows.at(-1)?.id]);
    return rows.length;
  });
}

/**
 * Yesterday's product mentions from public questions, by canonical product; and, for those with
 * at least 25 distinct contributors, a noisy count and a 30-day forecast. Below 25, nothing shows.
 */
export async function commerceRollup(db: Pick<Database, 'asSystem'>, secret: Buffer, now: number): Promise<number> {
  const day = new Date(now - 86_400_000).toISOString().slice(0, 10);
  return db.asSystem(async q => {
    await q.query("SELECT pg_advisory_xact_lock(hashtext('olap-commerce'))");
    const { rows } = await q.query<{ title: string; field: string; asker: string }>(
      `SELECT title, field, asker_id::text AS asker FROM app.questions q
       WHERE q.created_at >= $1::date AND q.created_at < $1::date + 1 AND NOT app.is_question_hidden(q.id) LIMIT 50000`,
      [day],
    );
    const mentions = new Map<
      string,
      { brand: string; label: string; count: number; fields: Map<string, HyperLogLog> }
    >();
    const counts = new Map<string, number>();
    for (const r of rows)
      for (const p of extractProducts(r.title)) {
        const m = mentions.get(p.key) ?? {
          brand: p.brand,
          label: p.label,
          count: 0,
          fields: new Map<string, HyperLogLog>(),
        };
        m.count += 1;
        const hll = m.fields.get(r.field) ?? new HyperLogLog();
        hll.add(dailyHash(secret, r.asker, day));
        m.fields.set(r.field, hll);
        mentions.set(p.key, m);
        counts.set(`${p.key}|${r.field}`, (counts.get(`${p.key}|${r.field}`) ?? 0) + 1);
      }
    const canonical = resolveEntities([...mentions].map(([key, m]) => ({ key, brand: m.brand, count: m.count })));
    let written = 0;
    for (const [key, m] of mentions) {
      const main = canonical.get(key) ?? key;
      const product = (
        await q.query<{ id: string }>(
          `INSERT INTO app.products (key, brand, label) VALUES ($1, $2, $3)
           ON CONFLICT (key) DO UPDATE SET brand = excluded.brand RETURNING id::text`,
          [main.slice(0, 80), m.brand, (mentions.get(main)?.label ?? m.label).slice(0, 120)],
        )
      ).rows[0]?.id;
      for (const [field, hll] of m.fields) {
        await q.query(
          `INSERT INTO app.product_mentions_daily (day, product_id, field_id, mentions, contributors)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (day, product_id, field_id) DO UPDATE SET mentions = excluded.mentions, contributors = excluded.contributors`,
          [day, product, field, counts.get(`${key}|${field}`) ?? 1, hll.toBytes()],
        );
        const contributors = hll.count();
        if (contributors < MIN_CONTRIBUTORS) continue;
        await q.query('UPDATE app.products SET k_reached = true WHERE id = $1', [product]);
        const history = (
          await q.query<{ mentions: number }>(
            `SELECT mentions FROM app.product_mentions_daily WHERE product_id = $1 AND field_id = $2 AND day > $3::date - 180 AND day <= $3 ORDER BY day`,
            [product, field, day],
          )
        ).rows.map(r => r.mentions);
        const forecast = history.length >= 28 ? forecastWithIntervals(history, 30) : [];
        const total = forecast.reduce((a, p) => a + p.value, 0);
        const noise = laplace(1 / 0.2, cellUniform(secret, `commerce|${day}|${field}|${String(product)}`));
        await q.query(
          `INSERT INTO app.olap_daily_commerce_cube (day, field_id, product_entity_id, k_distinct_contributors, dp_noisy_intent_count, holt_winters_forecast_30d, conformal_interval_90)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (day, field_id, product_entity_id) DO UPDATE SET dp_noisy_intent_count = excluded.dp_noisy_intent_count,
             k_distinct_contributors = excluded.k_distinct_contributors,
             holt_winters_forecast_30d = excluded.holt_winters_forecast_30d, conformal_interval_90 = excluded.conformal_interval_90`,
          [
            day,
            field,
            product,
            contributors,
            // Distinct people, so one person's many questions move it by one, as the noise assumes.
            Math.max(0, Math.round(contributors + noise)),
            forecast.length ? total : null,
            forecast[0] ? (forecast[0].high - forecast[0].low) / 2 : null,
          ],
        );
        written += 1;
      }
    }
    // Words nobody else used, unread for 30 days: gone (with their daily rows, by cascade).
    await q.query(
      `DELETE FROM app.products p WHERE NOT p.k_reached AND NOT EXISTS (
         SELECT 1 FROM app.product_mentions_daily d WHERE d.product_id = p.id AND d.day > $1::date - 30)`,
      [day],
    );
    return written;
  });
}

/** Topics, the products asked about under them, and each one's structural embedding. */
/**
 * A fixed random projection into the graph's dimensions (Johnson-Lindenstrauss), which roughly keeps which vectors are
 * near which. Seeded from the position, so the same meaning always lands in the same place.
 */
export function projectFeature(vector: readonly number[], dims: number): Float32Array {
  const out = new Float32Array(dims);
  vector.forEach((x, i) => {
    if (x === 0) return;
    for (let d = 0; d < dims; d++) {
      let h = Math.imul(i + 1, 0x9e3779b1) ^ Math.imul(d + 1, 0x85ebca77);
      h ^= h >>> 13;
      h = Math.imul(h, 0xc2b2ae3d);
      h ^= h >>> 16;
      const sign = h & 1 ? 1 : -1;
      out[d] = (out[d] ?? 0) + sign * x;
    }
  });
  const norm = Math.hypot(...out);
  return norm ? out.map(x => x / norm) : out;
}

export async function refreshKnowledgeGraph(db: Pick<Database, 'asSystem'>, now: number): Promise<number> {
  return db.asSystem(async q => {
    await q.query("SELECT pg_advisory_xact_lock(hashtext('kg-refresh'))");
    await q.query(`INSERT INTO app.kg_nodes (kind, key) SELECT 'field', slug FROM app.fields ON CONFLICT DO NOTHING`);
    await q.query(
      `INSERT INTO app.kg_nodes (kind, key) SELECT 'product', key FROM app.products WHERE k_reached ON CONFLICT DO NOTHING`,
    );
    const { rows } = await q.query<{ product: string; field: string; share: number }>(
      `WITH m AS (
         SELECT p.key AS product, d.field_id AS field, sum(d.mentions)::float8 AS n
         FROM app.product_mentions_daily d JOIN app.products p ON p.id = d.product_id
         WHERE d.day > now()::date - 90 AND p.k_reached GROUP BY 1, 2)
       SELECT product, field, (n / sum(n) OVER (PARTITION BY product))::float8 AS share FROM m`,
    );
    const validFrom = new Date(now);
    for (const r of rows)
      await q.query(
        `SELECT app.kg_assert(
           (SELECT id FROM app.kg_nodes WHERE kind = 'product' AND key = $1),
           (SELECT id FROM app.kg_nodes WHERE kind = 'field' AND key = $2), 'asked_under', $3, 1, $4)
         WHERE NOT EXISTS (
           SELECT 1 FROM app.kg_bitemporal_edges e
           WHERE e.source_node_id = (SELECT id FROM app.kg_nodes WHERE kind = 'product' AND key = $1)
             AND e.target_node_id = (SELECT id FROM app.kg_nodes WHERE kind = 'field' AND key = $2)
             AND e.relation_type = 'asked_under' AND e.tx_to = 'infinity' AND e.valid_to = 'infinity'
             AND abs(e.weight - $3::real) < 0.02)`,
        [r.product, r.field, r.share, validFrom],
      );
    const nodes = (await q.query<{ id: string }>('SELECT n.id::text FROM app.kg_nodes n ORDER BY n.id')).rows;
    const indexOf = new Map(nodes.map((n, i) => [n.id, i]));
    const edges: GraphEdge[] = [];
    for (const e of (
      await q.query<{ a: string; b: string; w: number; age: number }>(
        `SELECT source_node_id::text AS a, target_node_id::text AS b, weight AS w,
                extract(epoch FROM now() - valid_from)::float8 / 86400 AS age
         FROM app.kg_bitemporal_edges WHERE tx_to = 'infinity' AND valid_to = 'infinity'`,
      )
    ).rows) {
      const from = indexOf.get(e.a);
      const to = indexOf.get(e.b);
      if (from === undefined || to === undefined) continue;
      edges.push({ from, to, relation: 0, trust: e.w, ageDays: e.age });
      edges.push({ from: to, to: from, relation: 1, trust: e.w, ageDays: e.age });
    }
    // Deterministic features and weights, so an unchanged graph gets unchanged embeddings.
    let s = 42;
    const random = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32;
    const features = Float32Array.from({ length: nodes.length * DIMS }, () => random() - 0.5);
    // A topic starts from what its questions mean, where there's a model, so two topics about similar things start
    // close. The rest (and every topic before any embedding) keep their fixed random start.
    const meanings = (
      await q.query<{ node: string; vector: string }>(
        `SELECT n.id::text AS node, m.vector FROM app.field_mean_vectors() m
         JOIN app.kg_nodes n ON n.kind = 'field' AND n.key = m.field`,
      )
    ).rows;
    for (const m of meanings) {
      const at = indexOf.get(m.node);
      if (at !== undefined) features.set(projectFeature(JSON.parse(m.vector) as number[], DIMS), at * DIMS);
    }
    const h = embed(initSage(DIMS, 2, random), buildGraph(nodes.length, features, DIMS, edges));
    for (const [i, n] of nodes.entries())
      await q.query(
        `INSERT INTO app.kg_node_embeddings (node_id, embedding) VALUES ($1, $2)
         ON CONFLICT (node_id) DO UPDATE SET embedding = excluded.embedding, updated_at = now()`,
        [n.id, [...h.subarray(i * DIMS, (i + 1) * DIMS)]],
      );
    return rows.length;
  });
}

export const FEATURE_SCHEMA = 1;

/** One definition for online and offline: the topic's activity features, never a person's. */
export async function materializeFeatures(db: Pick<Database, 'asSystem'>, now: number): Promise<number> {
  return db.asSystem(async q => {
    const at = new Date(now);
    const { rows } = await q.query<{ field: string; q7: number; a7: number; q28: number }>(
      `SELECT f.slug AS field,
              (SELECT count(*) FROM app.questions x WHERE x.field = f.slug AND x.created_at > $1::timestamptz - interval '7 days' AND x.created_at <= $1)::int AS q7,
              (SELECT count(*) FROM app.answers a JOIN app.questions x ON x.id = a.question_id
               WHERE x.field = f.slug AND a.created_at > $1::timestamptz - interval '7 days' AND a.created_at <= $1)::int AS a7,
              (SELECT count(*) FROM app.questions x WHERE x.field = f.slug AND x.created_at > $1::timestamptz - interval '28 days' AND x.created_at <= $1)::int AS q28
       FROM app.fields f`,
      [at],
    );
    for (const r of rows) {
      const values = [r.q7, r.a7, r.q28];
      await writeFeature(q, 'field', r.field, 'activity', values, at);
    }
    return rows.length;
  });
}

export async function writeFeature(
  q: Queryable,
  entityType: string,
  entityId: string,
  group: string,
  values: readonly number[],
  validFrom: Date,
): Promise<void> {
  const params = [entityType, entityId, group, FEATURE_SCHEMA, values, validFrom];
  await q.query(
    `INSERT INTO app.feature_store_history (entity_type, entity_id, feature_group, feature_schema_version, numeric_features, valid_from)
     VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
    params,
  );
  await q.query(
    `INSERT INTO app.feature_store_online (entity_type, entity_id, feature_group, feature_schema_version, numeric_features, valid_from)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (entity_type, entity_id, feature_group) DO UPDATE SET numeric_features = excluded.numeric_features,
       valid_from = excluded.valid_from, feature_schema_version = excluded.feature_schema_version
     WHERE app.feature_store_online.valid_from <= excluded.valid_from`,
    params,
  );
}

export interface Observation {
  entityId: string;
  observedAt: string;
}

/** A point-in-time join: for each observation, the latest values recorded as valid by then, or nulls. */
export async function asOfJoin(
  q: Queryable,
  entityType: string,
  groups: readonly string[],
  observations: readonly Observation[],
): Promise<Array<Observation & { group: string; values: number[] | null; validFrom: string | null }>> {
  const { rows } = await q.query<{
    entity_id: string;
    observed_at: string;
    feature_group: string;
    numeric_features: number[] | null;
    valid_from: Date | null;
  }>(
    `SELECT o.entity_id, o.observed_at::text AS observed_at, g.feature_group, h.numeric_features, h.valid_from
     FROM unnest($2::text[], $3::timestamptz[]) AS o(entity_id, observed_at)
     CROSS JOIN unnest($4::text[]) AS g(feature_group)
     LEFT JOIN LATERAL (
       SELECT numeric_features, valid_from FROM app.feature_store_history f
       WHERE f.entity_type = $1 AND f.feature_group = g.feature_group AND f.entity_id = o.entity_id
         AND f.valid_from <= o.observed_at
       ORDER BY f.valid_from DESC LIMIT 1) h ON true`,
    [entityType, observations.map(o => o.entityId), observations.map(o => o.observedAt), [...groups]],
  );
  return rows.map(r => ({
    entityId: r.entity_id,
    observedAt: r.observed_at,
    group: r.feature_group,
    values: r.numeric_features,
    validFrom: r.valid_from?.toISOString() ?? null,
  }));
}

/** Every 5 minutes: each active campaign's λ against the day's traffic curve. A new day starts fresh. */
export async function stepPacers(db: Pick<Database, 'asSystem'>, now: number): Promise<number> {
  return db.asSystem(async q => {
    await q.query("SELECT pg_advisory_xact_lock(hashtext('ad-pacing'))");
    const hourly = new Array<number>(24).fill(0);
    for (const r of (
      await q.query<{ h: number; n: number }>(
        `SELECT extract(hour FROM shown_at AT TIME ZONE 'UTC')::int AS h, count(*)::int AS n FROM app.ad_impressions
         WHERE shown_at > now() - interval '14 days' GROUP BY 1`,
      )
    ).rows)
      hourly[r.h] = r.n;
    const curve = trafficCurve(hourly);
    const target = targetShare(curve, (now % 86_400_000) / 86_400_000);
    const day = new Date(now).toISOString().slice(0, 10);
    const { rows } = await q.query<{
      id: string;
      budget: string;
      spent: string;
      lambda: number | null;
      integral: number | null;
      last_error: number | null;
      day: string | null;
    }>(
      `SELECT c.id::text, c.daily_budget_micros::text AS budget, p.lambda, p.integral, p.last_error, p.day::text AS day,
              coalesce((SELECT sum(i.charged_micros) FROM app.ad_impressions i
                        WHERE i.campaign_id = c.id AND i.charged_at >= date_trunc('day', now(), 'UTC')), 0)::text AS spent
       FROM app.ad_campaigns c LEFT JOIN app.ad_pacing p ON p.campaign_id = c.id WHERE c.status = 'active'`,
    );
    for (const r of rows) {
      const state =
        r.day === day && r.lambda !== null
          ? { lambda: r.lambda, integral: r.integral ?? 0, lastError: r.last_error ?? 0 }
          : INITIAL_PACER;
      const next = stepPacer(state, Number(r.spent) / Math.max(1, Number(r.budget)), target);
      await q.query(
        `INSERT INTO app.ad_pacing (campaign_id, lambda, integral, last_error, day, updated_at)
         VALUES ($1, $2, $3, $4, $5, now())
         ON CONFLICT (campaign_id) DO UPDATE SET lambda = excluded.lambda, integral = excluded.integral,
           last_error = excluded.last_error, day = excluded.day, updated_at = now()`,
        [r.id, next.lambda, next.integral, next.lastError, day],
      );
    }
    return rows.length;
  });
}

export async function loadExperimentArms(q: Queryable, experiment: string) {
  const { rows } = await q.query<{ arm: string; x: number; y: number }>(
    `SELECT arm, pre_experiment_covariate_x AS x, post_metric_y AS y FROM app.exp_unit_metrics WHERE exp_id = $1`,
    [experiment],
  );
  const pick = (arm: string) => {
    const list = rows.filter(r => r.arm === arm);
    return { x: Float64Array.from(list, r => r.x), y: Float64Array.from(list, r => r.y) };
  };
  return { control: pick('control'), treatment: pick('treatment') };
}

/** Evaluates running experiments: SRM halts one; the always-valid p only ever falls. */
export async function evaluateExperiments(db: Pick<Database, 'asSystem'>): Promise<number> {
  return db.asSystem(async q => {
    const { rows } = await q.query<{ id: string; share: number; p: number }>(
      `SELECT exp_id::text AS id, control_share AS share, always_valid_p AS p FROM app.exp_definitions WHERE status = 'running'`,
    );
    for (const e of rows) {
      // Here rather than on a person's next visit, or people who stopped coming would keep an old figure. Late joiners'
      // answers from before they entered count too: arms are assigned at random, so that doesn't favour either.
      await q.query(
        `UPDATE app.exp_unit_metrics m SET post_metric_y = (SELECT count(*) FROM app.answers a, app.exp_definitions d
           WHERE d.exp_id = m.exp_id AND a.answerer_id = m.subject AND a.created_at >= d.created_at), updated_at = now()
         WHERE m.exp_id = $1 AND m.subject IS NOT NULL`,
        [e.id],
      );
      const { control, treatment } = await loadExperimentArms(q, e.id);
      if (control.y.length + treatment.y.length < 100) continue;
      const result = evaluate(control, treatment, [e.share, 1 - e.share], e.p);
      await q.query(
        `UPDATE app.exp_definitions SET srm_p_value = $2, always_valid_p = LEAST(always_valid_p, $3::float8),
           status = CASE WHEN $4 THEN 'halted_srm' ELSE status END WHERE exp_id = $1`,
        [e.id, result.srm.p, result.effect?.alwaysValidP ?? 1, result.srm.mismatch],
      );
      if (result.srm.mismatch)
        await audit(q, {
          action: 'experiment.halted_srm',
          actor: 'system',
          subject: e.id,
          detail: { p: result.srm.p },
        });
    }
    return rows.length;
  });
}

/** Appends one entry to the chain, under a lock: entries form one line, whatever runs at once. */
export async function audit(
  q: Queryable,
  entry: { action: string; actor: string; subject: string; detail: Record<string, unknown> },
): Promise<AuditEntry> {
  await q.query("SELECT pg_advisory_xact_lock(hashtext('audit-chain'))");
  const last = (
    await q.query<{ seq: string; hash: string }>(
      'SELECT l.seq::text, l.hash FROM app.audit_log l ORDER BY l.seq DESC LIMIT 1',
    )
  ).rows[0];
  const next = appendEntry(last ? { seq: Number(last.seq), hash: last.hash } : null, {
    ...entry,
    at: new Date().toISOString(),
  });
  await q.query(
    `INSERT INTO app.audit_log (seq, action, actor, subject, detail, at, prev_hash, hash) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [next.seq, next.action, next.actor, next.subject, next.detail, next.at, next.prevHash, next.hash],
  );
  return next;
}

/**
 * An entry written in the caller's own transaction, so it and the action commit or roll back together. System rights
 * last only for the entry: the rest of the transaction runs as the person it belongs to.
 */
export async function auditWithin(
  q: Queryable,
  entry: { action: string; actor: string; subject: string; detail: Record<string, unknown> },
): Promise<void> {
  const system = (on: string) => q.query("SELECT set_config('app.system', $1, true)", [on]);
  await system('on');
  await audit(q, entry);
  await system('');
}

/** The whole chain re-derived from its rows: the first broken entry, or null. */
export async function verifyAudit(q: Queryable): Promise<{ entries: number; brokenAt: number | null }> {
  const { rows } = await q.query<{
    seq: string;
    action: string;
    actor: string;
    subject: string;
    detail: Record<string, unknown>;
    at: Date;
    prev_hash: string;
    hash: string;
  }>(
    'SELECT l.seq::text, action, actor, subject, detail, at, prev_hash, hash FROM app.audit_log l ORDER BY l.seq LIMIT 100000',
  );
  const entries = rows.map(r => ({
    seq: Number(r.seq),
    action: r.action,
    actor: r.actor,
    subject: r.subject,
    detail: r.detail,
    at: r.at.toISOString(),
    prevHash: r.prev_hash,
    hash: r.hash,
  }));
  return { entries: entries.length, brokenAt: verifyChain(entries) };
}
