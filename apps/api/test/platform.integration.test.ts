// The platform's database and addresses, through the real server and Postgres, as the restricted
// role: who may reach what, what can't be rewritten, and what leaves nobody identifiable.
import { enrol } from '../src/experiments/enrol.ts';
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { hashKey } from '../src/routes/ad-measurement.ts';
import {
  asOfJoin,
  audit,
  commerceRollup,
  drainJournal,
  evaluateExperiments,
  materializeFeatures,
  refreshKnowledgeGraph,
  stepPacers,
  verifyAudit,
  writeFeature,
} from '../src/platform/jobs.ts';
import { startApp, type TestApp } from './helpers/app.ts';
import { must } from './helpers/must.ts';

const SECRET = Buffer.alloc(32, 5);
let h: TestApp;
let n = 0;

beforeAll(async () => {
  h = await startApp(() => Date.now(), { adsEnabled: () => true });
  return h.close;
});

async function member(country = 'IN') {
  const p = await h.person();
  n += 1;
  expect(
    (
      await h.call('POST', '/me/profile', p.token, {
        handle: `plat.${String(n)}`,
        country,
        fields: ['travel'],
        adult: true,
      })
    ).statusCode,
  ).toBe(201);
  await h.t.owner.query("UPDATE app.profiles SET created_at = now() - interval '2 days' WHERE id = $1", [p.id]);
  return p;
}
async function owner() {
  const p = await member();
  await h.t.owner.query('INSERT INTO app.platform_owners (profile_id) VALUES ($1)', [p.id]);
  return p;
}
const db = () => h.t.database;

describe('the owner’s addresses', () => {
  const addresses: Array<['GET' | 'POST', string, object?]> = [
    ['GET', '/owner/dashboard/summary'],
    [
      'POST',
      '/knowledge-graph/bitemporal/query',
      { entityKey: 'travel', validAt: '2026-01-01T00:00:00Z', transactionAt: '2026-01-01T00:00:00Z' },
    ],
    [
      'POST',
      '/feature-store/as-of-join',
      {
        entityType: 'field',
        featureGroups: ['activity'],
        observationTimestamps: [{ entityId: 'travel', observedAt: '2026-01-01T00:00:00Z' }],
      },
    ],
    ['GET', '/experiments/evaluate?experimentId=1'],
    ['GET', '/commerce/intelligence/forecast?fieldSlug=travel'],
  ];
  it('refuse the signed out and ordinary people, moderators included, and admit an owner', async () => {
    const someone = await member();
    const moderator = await member();
    await h.t.owner.query('INSERT INTO app.moderators (profile_id) VALUES ($1)', [moderator.id]);
    const boss = await owner();
    for (const [method, url, body] of addresses) {
      expect((await h.call(method, url, undefined, body)).statusCode, url).toBe(401);
      expect((await h.call(method, url, someone.token, body)).statusCode, url).toBe(403);
      expect((await h.call(method, url, moderator.token, body)).statusCode, url).toBe(403);
      expect((await h.call(method, url, boss.token, body)).statusCode, url).toBe(200);
    }
  });
  it('the API role can’t make itself an owner or read the cubes', async () => {
    await expect(
      h.t.api.query('INSERT INTO app.platform_owners (profile_id) VALUES ($1)', [randomUUID()]),
    ).rejects.toThrow(/permission/i);
    expect((await h.t.api.query('SELECT 1 FROM app.olap_daily_platform_cube')).rows).toEqual([]);
    expect((await h.t.api.query('SELECT 1 FROM app.audit_log')).rows).toEqual([]);
    expect((await h.t.api.query('SELECT 1 FROM app.feature_store_history')).rows).toEqual([]);
  });
});

describe('the journal and cubes', () => {
  it('count posts, drain the journal, and keep nobody’s id', async () => {
    const asker = await member();
    expect(
      (
        await h.call('POST', '/questions', asker.token, {
          title: 'Is the Samsung Galaxy S24 worth importing to India?',
          field: 'phones-gadgets',
        })
      ).statusCode,
    ).toBe(201);
    const before = await h.t.owner.query<{ c: number }>('SELECT count(*)::int AS c FROM app.analytics_event_journal');
    expect(must(before.rows[0]).c).toBeGreaterThan(0);
    expect(await drainJournal(db(), SECRET)).toBeGreaterThan(0);
    expect(
      must((await h.t.owner.query<{ c: number }>('SELECT count(*)::int AS c FROM app.analytics_event_journal')).rows[0])
        .c,
    ).toBe(0);
    const { rows } = await h.t.owner.query<{ questions: string; hll: Buffer }>(
      "SELECT questions::text, hll_unique_users AS hll FROM app.olap_daily_platform_cube WHERE field_id = 'phones-gadgets'",
    );
    expect(Number(must(rows[0]).questions)).toBeGreaterThan(0);
    expect(must(rows[0]).hll.includes(Buffer.from(asker.id))).toBe(false);
  });
  it('deleting an account removes its journal rows', async () => {
    const p = await member();
    await h.call('POST', '/questions', p.token, {
      title: 'How long does a passport renewal take now?',
      field: 'travel',
    });
    await h.t.owner.query('DELETE FROM app.profiles WHERE id = $1', [p.id]);
    expect(
      (await h.t.owner.query('SELECT 1 FROM app.analytics_event_journal WHERE subject = $1', [p.id])).rows,
    ).toEqual([]);
  });
  it('INVARIANT: a commerce row can’t exist under 25 contributors, by job or by database', async () => {
    await commerceRollup(db(), SECRET, Date.now() + 86_400_000);
    expect(
      (await h.t.owner.query('SELECT 1 FROM app.olap_daily_commerce_cube WHERE k_distinct_contributors < 25')).rows,
    ).toEqual([]);
    const product = must(
      (
        await h.t.owner.query<{ id: string }>(
          "INSERT INTO app.products (key, brand, label) VALUES ('x-1', 'x', 'x') RETURNING id::text",
        )
      ).rows[0],
    ).id;
    await expect(
      h.t.owner.query(
        "INSERT INTO app.olap_daily_commerce_cube (day, field_id, product_entity_id, k_distinct_contributors, dp_noisy_intent_count) VALUES (now(), 'travel', $1, 24, 1)",
        [product],
      ),
    ).rejects.toThrow(/check/i);
  });
});

describe('the knowledge graph', () => {
  it('time travels: past beliefs stay exactly as they were', async () => {
    const q = h.t.owner;
    const node = async (key: string) =>
      must(
        (
          await q.query<{ id: string }>(
            "INSERT INTO app.kg_nodes (kind, key) VALUES ('product', $1) RETURNING id::text",
            [key],
          )
        ).rows[0],
      ).id;
    const [a, b] = [await node('kg-a'), await node('kg-b')];
    await q.query("SELECT app.kg_assert($1, $2, 'duty_rate', 0.2, 1, '2025-01-01')", [a, b]);
    // A JavaScript date keeps only milliseconds: step past the first belief's microseconds.
    await q.query('SELECT pg_sleep(0.01)');
    const firstTx = must((await q.query<{ t: string }>('SELECT clock_timestamp()::text AS t')).rows[0]).t;
    await q.query('SELECT pg_sleep(0.01)');
    await q.query("SELECT app.kg_assert($1, $2, 'duty_rate', 0.4, 1, '2026-01-01')", [a, b]);
    const boss = await owner();
    const ask = async (validAt: string, transactionAt: string) =>
      (
        await h.call('POST', '/knowledge-graph/bitemporal/query', boss.token, {
          entityKey: 'kg-a',
          validAt,
          transactionAt,
          maxHops: 1,
        })
      )
        .json<{ edges: Array<{ weight: number }> }>()
        .edges.map(e => Number(e.weight.toFixed(1)));
    const now = new Date().toISOString();
    expect(await ask('2025-06-01T00:00:00Z', now)).toEqual([0.2]);
    expect(await ask('2026-06-01T00:00:00Z', now)).toEqual([0.4]);
    // What we believed then about 2026, before the correction arrived.
    expect(await ask('2026-06-01T00:00:00Z', new Date(firstTx).toISOString())).toEqual([0.2]);
    await expect(
      q.query('UPDATE app.kg_bitemporal_edges SET weight = 0.9 WHERE source_node_id = $1', [a]),
    ).rejects.toThrow(/rewritten/);
    await refreshKnowledgeGraph(db(), Date.now());
    expect(
      must(
        (await q.query<{ d: number }>('SELECT cardinality(embedding) AS d FROM app.kg_node_embeddings LIMIT 1'))
          .rows[0],
      ).d,
    ).toBe(64);
  });
  it('pools steps with no person, only with consent, shows nothing until several are seen, and refuses made-up topics', async () => {
    const p = await member();
    const stepBy = (token: string | undefined, body: object) =>
      h.call('POST', '/knowledge-graph/transitions', token, body);
    const next = async () =>
      (await h.call('GET', '/knowledge-graph/next?current=travel')).json<{
        next: Array<{ field: string; name: string; because: string }>;
      }>().next;
    const stored = async () =>
      (await h.t.owner.query("SELECT 1 FROM app.kg_session_transitions WHERE from_key = 'travel'")).rowCount;
    // Signed out, without agreeing, or with Global Privacy Control: the same answer, and nothing kept.
    expect((await stepBy(undefined, { from: 'travel', to: 'visas-immigration' })).statusCode).toBe(204);
    expect((await stepBy(p.token, { from: 'travel', to: 'visas-immigration' })).statusCode).toBe(204);
    expect(await stored()).toBe(0);
    await h.call('PUT', '/me/consents', p.token, { choices: [{ category: 'anonymous_analytics', enabled: true }] });
    const gpc = await h.app.inject({
      method: 'POST',
      url: '/knowledge-graph/transitions',
      headers: { authorization: `Bearer ${p.token}`, 'sec-gpc': '1' },
      payload: { from: 'travel', to: 'visas-immigration' },
    });
    expect(gpc.statusCode).toBe(204);
    expect(await stored()).toBe(0);

    const agreeing = async () => {
      const m = await member();
      await h.call('PUT', '/me/consents', m.token, { choices: [{ category: 'anonymous_analytics', enabled: true }] });
      return m;
    };
    const step = (body: object) => stepBy(p.token, body);
    expect((await step({ from: 'travel', to: 'visas-immigration' })).statusCode).toBe(204);
    expect((await next()).filter(n => n.because === 'journeys')).toEqual([]);
    // One person repeating a step counts once: they can't put a pair on everyone's pages by themselves.
    for (let i = 0; i < 6; i++) await step({ from: 'travel', to: 'visas-immigration' });
    expect((await next()).filter(n => n.because === 'journeys')).toEqual([]);
    for (let i = 0; i < 5; i++) await stepBy((await agreeing()).token, { from: 'travel', to: 'visas-immigration' });
    expect(must((await next())[0])).toMatchObject({ field: 'visas-immigration', because: 'journeys' });
    expect(must((await next())[0])).not.toHaveProperty('probability');
    expect(must((await next())[0]).name).not.toBe('visas-immigration');
    await step({ from: 'travel', to: 'made-up-topic' });
    expect(
      (await h.t.owner.query("SELECT 1 FROM app.kg_session_transitions WHERE to_key = 'made-up-topic'")).rows,
    ).toEqual([]);
  });

  it('fills in from graph embeddings when journeys are thin, and only close ones', async () => {
    const node = async (key: string, embedding: number[]) => {
      const { rows } = await h.t.owner.query<{ id: string }>(
        `INSERT INTO app.kg_nodes (kind, key) VALUES ('field', $1)
         ON CONFLICT (kind, key) DO UPDATE SET key = excluded.key RETURNING id::text`,
        [key],
      );
      await h.t.owner.query(
        `INSERT INTO app.kg_node_embeddings (node_id, embedding) VALUES ($1, $2)
         ON CONFLICT (node_id) DO UPDATE SET embedding = excluded.embedding`,
        [must(rows[0]).id, embedding],
      );
    };
    const axis = (i: number) => Array.from({ length: 64 }, (_, k) => (k === i ? 1 : 0));
    await node('food-cooking', axis(0));
    await node('money-tax', [0.9, 0.1, ...Array<number>(62).fill(0)]);
    await node('imports-customs', axis(5));
    const { next } = (await h.call('GET', '/knowledge-graph/next?current=food-cooking')).json<{
      next: Array<{ field: string; because: string }>;
    }>();
    expect(next.map(n => n.field)).toEqual(['money-tax']);
    expect(next[0]).toMatchObject({ because: 'related' });
  });
});

describe('the feature store', () => {
  it('INVARIANT: a training row never sees a value from after its label, in the real table', async () => {
    const t0 = Date.UTC(2026, 0, 1);
    await db().asSystem(async q => {
      for (let i = 0; i < 20; i++) await writeFeature(q, 'field', 'leak-test', 'g', [i], new Date(t0 + i * 3_600_000));
    });
    await db().asSystem(async q => {
      for (let i = 0; i < 200; i++) {
        const at = t0 + Math.floor(Math.random() * 22 * 3_600_000) - 3_600_000;
        const [row] = await asOfJoin(
          q,
          'field',
          ['g'],
          [{ entityId: 'leak-test', observedAt: new Date(at).toISOString() }],
        );
        const r = must(row);
        if (at < t0) expect(r.values).toBeNull();
        else {
          expect(new Date(must(r.validFrom)).getTime()).toBeLessThanOrEqual(at);
          expect(r.values?.[0]).toBe(Math.min(19, Math.floor((at - t0) / 3_600_000)));
        }
      }
    });
    await materializeFeatures(db(), Date.now());
    expect(
      must(
        (
          await h.t.owner.query<{ d: number }>(
            "SELECT cardinality(numeric_features) AS d FROM app.feature_store_online WHERE entity_type = 'field' AND entity_id = 'travel'",
          )
        ).rows[0],
      ).d,
    ).toBe(3);
  });
});

describe('model lineage', () => {
  it('what a version was trained on can’t be changed', async () => {
    const o = h.t.owner;
    await o.query(
      "INSERT INTO app.ml_models (name, version, algorithm, params, dataset, metrics, baseline, status, reason) VALUES ('lineage', 1, 'hashed-word-tfidf', '{}', '{}', '{}', '{}', 'rejected', 'r')",
    );
    await expect(o.query("UPDATE app.ml_models SET params = '{\"a\":1}' WHERE name = 'lineage'")).rejects.toThrow(
      /lineage/,
    );
    await expect(o.query("UPDATE app.ml_models SET algorithm = 'other' WHERE name = 'lineage'")).rejects.toThrow(
      /lineage/,
    );
    await expect(
      db().asSystem(q => q.query("UPDATE app.ml_models SET dataset = '{}' WHERE name = 'lineage'")),
    ).rejects.toThrow(/permission/i);
  });
});

describe('experiments', () => {
  it('buckets can’t overlap in a layer; arms are stable; SRM halts one', async () => {
    const o = h.t.owner;
    const layer = must(
      (
        await o.query<{ id: string }>(
          "INSERT INTO app.exp_layers (name) VALUES ('ranking') RETURNING layer_id::text AS id",
        )
      ).rows[0],
    ).id;
    const exp = must(
      (
        await o.query<{ id: string }>(
          "INSERT INTO app.exp_definitions (layer_id, name, bucket_start, bucket_end, status) VALUES ($1, 'wide', 0, 10000, 'running') RETURNING exp_id::text AS id",
          [layer],
        )
      ).rows[0],
    ).id;
    await expect(
      o.query(
        "INSERT INTO app.exp_definitions (layer_id, name, bucket_start, bucket_end) VALUES ($1, 'over', 9000, 10000)",
        [layer],
      ),
    ).rejects.toThrow(/overlap/);
    const p = await member();
    const first = (await h.call('GET', '/me/experiments', p.token)).json<{
      experiments: Array<{ arm: string; experiment: string }>;
    }>();
    expect(first.experiments).toHaveLength(1);
    expect((await h.call('GET', '/me/experiments', p.token)).json()).toEqual(first);
    await enrol(db(), p.id, must(first.experiments[0]).experiment);
    const units = await o.query<{ unit_id: string }>('SELECT unit_id FROM app.exp_unit_metrics WHERE exp_id = $1', [
      exp,
    ]);
    expect(must(units.rows[0]).unit_id).not.toContain(p.id);
    await o.query(
      `INSERT INTO app.exp_unit_metrics (exp_id, unit_id, arm) SELECT $1, md5(g::text) || 'aaaaaaaa', CASE WHEN g % 10 = 0 THEN 'treatment' ELSE 'control' END FROM generate_series(1, 400) g`,
      [exp],
    );
    await evaluateExperiments(db());
    expect(
      must(
        (await o.query<{ status: string }>('SELECT status FROM app.exp_definitions WHERE exp_id = $1', [exp])).rows[0],
      ).status,
    ).toBe('halted_srm');
  });
});

describe('the audit chain', () => {
  it('keeps counting past ten entries: sequence numbers sort as numbers, not text', async () => {
    for (let i = 0; i < 12; i++)
      await db().asSystem(q => audit(q, { action: 'test.count', actor: 'system', subject: 's', detail: {} }));
    expect(await db().asSystem(verifyAudit)).toMatchObject({ brokenAt: null });
  });

  it('is append-only in the database, and verification finds a forged row', async () => {
    await db().asSystem(q => audit(q, { action: 'test.one', actor: 'system', subject: 's', detail: { a: 1 } }));
    await db().asSystem(q => audit(q, { action: 'test.two', actor: 'system', subject: 's', detail: {} }));
    expect((await db().asSystem(verifyAudit)).brokenAt).toBeNull();
    await expect(h.t.owner.query("UPDATE app.audit_log SET actor = 'x'")).rejects.toThrow(/append-only/);
    await expect(h.t.owner.query('DELETE FROM app.audit_log')).rejects.toThrow(/append-only/);
    await h.t.owner.query('ALTER TABLE app.audit_log DISABLE TRIGGER audit_log_no_change');
    await h.t.owner.query("UPDATE app.audit_log SET subject = 'forged' WHERE seq = 1");
    await h.t.owner.query('ALTER TABLE app.audit_log ENABLE TRIGGER audit_log_no_change');
    expect((await db().asSystem(verifyAudit)).brokenAt).toBe(1);
  });
});

describe('complaints', () => {
  it('set their own clocks, and only the complainant and moderators see them', async () => {
    const p = await member();
    const res = await h.call('POST', '/grievances', p.token, {
      kind: 'unlawful_content',
      body: 'This post shares my phone number.',
    });
    expect(res.statusCode).toBe(201);
    const g = res.json<{ grievance: { id: string; resolveBy: string; acknowledgeBy: string } }>().grievance;
    const hours = (new Date(g.resolveBy).getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(71);
    expect(hours).toBeLessThan(73);
    const other = await member();
    expect((await h.call('GET', '/ops/grievances', other.token)).statusCode).toBe(403);
    expect((await h.call('PATCH', `/ops/grievances/${g.id}`, other.token, { action: 'acknowledge' })).statusCode).toBe(
      403,
    );
    await expect(
      h.t.owner.query(
        "INSERT INTO app.statements_of_reasons (restriction, facts, automated, redress) VALUES ('removal', 'long enough facts', false, 'long enough redress')",
      ),
    ).rejects.toThrow(/check/i);
  });
});

describe('memory', () => {
  it('needs consent, and withdrawing forgets everything in that moment', async () => {
    const p = await member();
    const put = () => h.call('PUT', '/me/memory/preferences/currency', p.token, { value: 'INR' });
    expect((await put()).statusCode).toBe(403);
    await h.call('PUT', '/me/consents', p.token, { choices: [{ category: 'memory_personalization', enabled: true }] });
    expect((await put()).statusCode).toBe(200);
    expect((await h.call('PUT', '/me/memory/preferences/currency', p.token, { value: 'NOPE' })).statusCode).toBe(400);
    expect((await h.call('GET', '/me/memory', p.token)).json<{ entries: unknown[] }>().entries).toHaveLength(1);
    const other = await member();
    expect((await h.call('GET', '/me/memory', other.token)).json<{ entries: unknown[] }>().entries).toEqual([]);
    await h.call('PUT', '/me/consents', p.token, { choices: [{ category: 'memory_personalization', enabled: false }] });
    expect((await h.call('GET', '/me/memory', p.token)).json<{ entries: unknown[] }>().entries).toEqual([]);
  });
});

describe('evidence from answers', () => {
  it('quotes only what people wrote, cited', async () => {
    const asker = await member();
    const q = must(
      (
        await h.call('POST', '/questions', asker.token, {
          title: 'What does customs charge on a watch these days?',
          field: 'imports-customs',
        })
      ).json<{ question: { id: string } }>().question.id,
    );
    const a = await member();
    await h.t.owner.query(
      "INSERT INTO app.answers (question_id, answerer_id, body) VALUES ($1, $2, 'I paid ₹12,000 in duty last March and it cleared in 3 days at Chennai.')",
      [q, a.id],
    );
    const { claims } = (await h.call('GET', `/questions/${q}/evidence`)).json<{
      claims: Array<{ value: number; quote: string; answerId: string }>;
    }>();
    expect(claims.find(c => c.value === 12000)?.quote).toContain('₹12,000');
    expect(claims.every(c => c.answerId.length > 0)).toBe(true);
  });
});

describe('partner signals, under the switches', () => {
  it('count a known id with a real key, answer the same for anything else, and stop on withdrawal', async () => {
    const o = h.t.owner;
    await o.query(
      "UPDATE app.feature_flags SET enabled = true WHERE name IN ('ads','ads_partner_sites','ads_behavioral','ads_audiences')",
    );
    await o.query('UPDATE app.ad_jurisdiction_rules SET legal_approved = true');
    const p = await member();
    await h.call('PUT', '/me/consents', p.token, {
      choices: [
        { category: 'ads_personalization', enabled: true },
        { category: 'ads_partner_sites', enabled: true },
      ],
    });
    await o.query('INSERT INTO app.ad_identities (profile_id) VALUES ($1) ON CONFLICT DO NOTHING', [p.id]);
    const adId = must(
      (await o.query<{ ad_id: string }>('SELECT ad_id::text FROM app.ad_identities WHERE profile_id = $1', [p.id]))
        .rows[0],
    ).ad_id;
    const eid = 'abcdefghijklmnopqrstuv';
    const biz = must(
      (
        await o.query<{ id: string }>(
          "INSERT INTO app.ad_advertisers (name, country, status) VALUES ('Boats', 'IN', 'active') RETURNING id::text",
        )
      ).rows[0],
    ).id;
    await o.query(
      "INSERT INTO app.ad_eids (eid, ad_id, expires_at, scope) VALUES ($1, $2, now() + interval '1 day', 'advertiser:' || $3)",
      [eid, adId, biz],
    );
    const key = `grk_${'k'.repeat(43)}`;
    await o.query("INSERT INTO app.ad_api_keys (advertiser_id, key_hash, prefix) VALUES ($1, $2, 'grk_kkkkkk')", [
      biz,
      hashKey(key),
    ]);
    const send = (token: string, eidToken: string, eventId: string) =>
      h.app.inject({
        method: 'POST',
        url: '/ads/partner-events',
        headers: { authorization: `Bearer ${token}` },
        payload: { eidToken, event: 'PRODUCT_VIEW', eventId },
      });
    // Every answer reads the same; only the table knows.
    for (const r of [
      await send(key, eid, 'e1'),
      await send(key, eid, 'e1'),
      await send(`grk_${'x'.repeat(43)}`, eid, 'e2'),
      await send(key, 'z'.repeat(22), 'e3'),
    ])
      expect(r.json()).toEqual({ accepted: true });
    expect(
      must(
        (await o.query<{ c: number }>('SELECT count(*)::int AS c FROM app.ad_partner_events WHERE ad_id = $1', [adId]))
          .rows[0],
      ).c,
    ).toBe(1);
    // Under 100 matches: no list, no count, no way to test one person.
    const match = await h.app.inject({
      method: 'POST',
      url: '/ads/audiences/partner-match',
      headers: { authorization: `Bearer ${key}` },
      payload: { name: 'cart', eidTokens: [eid] },
    });
    expect(match.json()).toEqual({ status: 'insufficient' });
    expect((await o.query("SELECT 1 FROM app.ad_audiences WHERE kind = 'partner_match'")).rows).toEqual([]);
    // Turning personalized ads off rotates the identity: id and events go with it.
    await h.call('PUT', '/me/consents', p.token, { choices: [{ category: 'ads_personalization', enabled: false }] });
    expect((await o.query('SELECT 1 FROM app.ad_partner_events WHERE ad_id = $1', [adId])).rows).toEqual([]);
    expect((await send(key, eid, 'e4')).json()).toEqual({ accepted: true });
    expect((await o.query("SELECT 1 FROM app.ad_partner_events WHERE external_id = 'e4'")).rows).toEqual([]);
    expect(await stepPacers(db(), Date.now())).toBeGreaterThanOrEqual(0);
  });
});
