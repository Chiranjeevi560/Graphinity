// Ads part 9b through the real server, and the charter's money and firewall invariants.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import fc from 'fast-check';
import { beforeAll, describe, expect, it } from 'vitest';
import { fieldsOfTopics } from '../src/ads/inbound.ts';
import { choose, indexCampaigns, INBOUND_BOOST, type IndexedCampaign } from '../src/ads/serve.ts';
import { advanceStage, recordPromoted } from '../src/ml/registry.ts';
import { commerceRollup, drainJournal, stepPacers } from '../src/platform/jobs.ts';
import { startAdWorld, crowd, type Ad } from './helpers/ads.ts';
import type { TestApp } from './helpers/app.ts';
import { must } from './helpers/must.ts';

let w: Awaited<ReturnType<typeof startAdWorld>>;
let h: TestApp;

beforeAll(async () => {
  w = await startAdWorld('nineb', ['ads', 'ads_behavioral', 'ads_partner_sites', 'ads_measurement']);
  h = w.h;
  return h.close;
});

const allow = (token: string, ...categories: string[]) =>
  h.call('PUT', '/me/consents', token, { choices: categories.map(category => ({ category, enabled: true })) });

describe('holdouts', () => {
  it('put about a tenth of tracked readers in the ghost arm, showing them nothing from that campaign', async () => {
    await h.t.owner.query("UPDATE app.feature_flags SET enabled = true WHERE name = 'ads_holdout'");
    const live = await w.liveCampaign([{ kind: 'field', value: 'travel' }], { frequencyCap: 20 });
    const q = await w.question();
    let shown = 0;
    let ghost = 0;
    for (let i = 0; i < 60; i++) {
      const p = await w.member();
      await allow(p.token, 'ads_personalization');
      const ads = await w.select(p.token, { placement: 'question', questionId: q });
      if (ads.some(a => a.headline === live.headline)) shown += 1;
      else ghost += 1;
    }
    const rows = await h.t.owner.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM app.ad_ghost_impressions g JOIN app.ad_campaigns c ON c.id = g.campaign_id WHERE c.public_id = $1`,
      [live.campaign],
    );
    expect(must(rows.rows[0]).c).toBe(ghost);
    expect(ghost).toBeGreaterThan(0);
    expect(shown).toBeGreaterThan(40);
    // A signed-out reader has no identity to hold out, so always sees it.
    expect(
      (await w.select(undefined, { placement: 'question', questionId: q })).some(a => a.headline === live.headline),
    ).toBe(true);
    await h.t.owner.query("UPDATE app.feature_flags SET enabled = false WHERE name = 'ads_holdout'");
  });

  it('report lift only with enough people, and only to the business', async () => {
    const live = await w.liveCampaign([{ kind: 'field', value: 'travel' }]);
    const url = `/ads/campaigns/${live.campaign}/lift`;
    expect((await h.call('GET', url, live.owner.token)).json()).toEqual({ ready: false });
    const stranger = await w.member();
    expect((await h.call('GET', url, stranger.token)).statusCode).toBe(404);
    const o = h.t.owner;
    const campaign = must(
      (
        await o.query<{ id: string; adv: string }>(
          'SELECT id::text, advertiser_id::text AS adv FROM app.ad_campaigns WHERE public_id = $1',
          [live.campaign],
        )
      ).rows[0],
    );
    const { adIds } = await crowd(w, 400, { travel: 3 });
    for (const [i, adId] of adIds.entries()) {
      if (i % 2)
        await o.query(
          'INSERT INTO app.ad_ghost_impressions (campaign_id, ad_id, counterfactual_micros) VALUES ($1, $2, 1000)',
          [campaign.id, adId],
        );
      else {
        const creative = must(
          (
            await o.query<{ id: string }>('SELECT id::text FROM app.ad_creatives WHERE campaign_id = $1 LIMIT 1', [
              campaign.id,
            ])
          ).rows[0],
        ).id;
        await o.query(
          "INSERT INTO app.ad_impressions (campaign_id, creative_id, ad_id, placement, price_micros) VALUES ($1, $2, $3, 'search', 1000)",
          [campaign.id, creative, adId],
        );
      }
      if (i % 2 === 0 ? i % 4 === 0 : i % 20 === 1)
        await o.query(
          "INSERT INTO app.ad_partner_events (advertiser_id, ad_id, kind, external_id, value_micros) VALUES ($1, $2, 'PURCHASE', $3, 1000000)",
          [campaign.adv, adId, `sale-${String(i)}`],
        );
    }
    const res = (await h.call('GET', url, live.owner.token)).json<{
      ready: boolean;
      lift: { absolute: number; significant: boolean };
    }>();
    expect(res.ready).toBe(true);
    expect(res.lift.absolute).toBeGreaterThan(0.2);
    expect(res.lift.significant).toBe(true);
  });
});

describe('pacing', () => {
  it('lowers an overspending campaign’s bid, and only with its switch on', async () => {
    const live = await w.liveCampaign([{ kind: 'field', value: 'money-tax' }]);
    const o = h.t.owner;
    const id = must(
      (await o.query<{ id: string }>('SELECT id::text FROM app.ad_campaigns WHERE public_id = $1', [live.campaign]))
        .rows[0],
    ).id;
    const creative = must(
      (await o.query<{ id: string }>('SELECT id::text FROM app.ad_creatives WHERE campaign_id = $1 LIMIT 1', [id]))
        .rows[0],
    ).id;
    await o.query(
      "INSERT INTO app.ad_impressions (campaign_id, creative_id, placement, price_micros, charged_micros, clicked_at) VALUES ($1, $2, 'search', 49000000, 49000000, now())",
      [id, creative],
    );
    // An hour into the day with 98% of the budget gone: far ahead of the curve.
    const earlyToday = new Date().setUTCHours(1, 0, 0, 0);
    await stepPacers(h.t.database, earlyToday);
    await stepPacers(h.t.database, earlyToday);
    const row = must(
      (await o.query<{ lambda: number }>('SELECT lambda FROM app.ad_pacing WHERE campaign_id = $1', [id])).rows[0],
    );
    await o.query("UPDATE app.feature_flags SET enabled = true WHERE name = 'ads_pacing'");
    await w.server().refresh();
    await w.select(undefined, { placement: 'search', field: 'money-tax' });
    await o.query("UPDATE app.feature_flags SET enabled = false WHERE name = 'ads_pacing'");
    await w.server().refresh();
    expect(row.lambda).toBeGreaterThan(1);
  });
});

describe('inbound signals', () => {
  const campaign = (id: string, field: string): IndexedCampaign => ({
    id,
    advertiser: id,
    advertiserId: id,
    maxCpcMicros: 1_000_000,
    dailyBudgetMicros: 1e9,
    frequencyCap: 5,
    spentMicros: 0,
    impressions: 0,
    clicks: 0,
    creatives: [{ id: `${id}-c`, headline: 'h', body: 'b', domain: 'x.example' }],
    targets: new Map([['field', new Set([field])]]),
    reminders: new Set(),
  });
  it('boost only a campaign targeting what the reader came for', () => {
    const index = indexCampaigns([campaign('a', 'travel'), { ...campaign('b', 'shopping'), maxCpcMicros: 2_000_000 }]);
    const ctx = {
      placement: 'question' as const,
      fields: ['travel', 'shopping'],
      words: [],
      country: null,
      interests: null,
    };
    const plain = choose(index, ctx, new Map(), 3_600_000);
    expect(plain.wins[0]?.campaignId).toBe('b');
    const boosted = choose(index, { ...ctx, inbound: new Set(['travel']) }, new Map(), 3_600_000);
    expect(boosted.wins[0]?.campaignId).toBe('a');
    expect(INBOUND_BOOST).toBe(3.5);
  });
  it('map browser topics by the published taxonomy, and sensitive ones to nothing', () => {
    expect(fieldsOfTopics([57])).toEqual(['cars-vehicles']);
    expect(fieldsOfTopics([149])).toEqual(['money-tax']);
    expect(fieldsOfTopics([239])).toEqual([]);
    expect(fieldsOfTopics([1])).toEqual([]);
  });
  it('are ignored for one who hasn’t allowed partner sites, and never stored', async () => {
    const live = await w.liveCampaign([{ kind: 'keyword', value: 'zanzibar' }]);
    const p = await w.member();
    await allow(p.token, 'ads_personalization');
    const body = { placement: 'search', landingQuery: 'zanzibar ferry', browserTopics: [332] };
    expect((await w.select(p.token, body)).some(a => a.headline === live.headline)).toBe(false);
    await allow(p.token, 'ads_partner_sites');
    expect((await w.select(p.token, body)).some(a => a.headline === live.headline)).toBe(true);
    const gpc = await h.app.inject({
      method: 'POST',
      url: '/ads/select',
      headers: { authorization: `Bearer ${p.token}`, 'sec-gpc': '1' },
      payload: body,
    });
    expect(gpc.json<{ ads: Ad[] }>().ads.some(a => a.headline === live.headline)).toBe(false);
    const { rows } = await h.t.owner.query("SELECT 1 FROM app.ad_impressions i WHERE i.field = 'zanzibar'");
    expect(rows).toEqual([]);
  });
  it('a tap carries a rotating id only with permission and without GPC', async () => {
    const live = await w.liveCampaign([{ kind: 'field', value: 'fitness' }]);
    const p = await w.member();
    await allow(p.token, 'ads_personalization', 'ads_partner_sites');
    const ad = (await w.select(p.token, { placement: 'search', field: 'fitness' })).find(
      a => a.headline === live.headline,
    );
    const tap = await h.call('POST', `/ads/click/${must(ad).token}`, p.token);
    const eid = new URL(tap.json<{ destination: string }>().destination).searchParams.get('gr_eid');
    expect(eid).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(eid).not.toContain(p.id);
    const q = await w.member();
    const other = (await w.select(q.token, { placement: 'search', field: 'fitness' })).find(
      a => a.headline === live.headline,
    );
    const plain = await h.call('POST', `/ads/click/${must(other).token}`, q.token);
    expect(new URL(plain.json<{ destination: string }>().destination).searchParams.has('gr_eid')).toBe(false);
  });
});

describe('INVARIANT 1: budget and billing', () => {
  it('over any stream of clicks and retries, nothing is billed twice or past the day’s budget', async () => {
    const budget = 3_000_000;
    const live = await w.liveCampaign([{ kind: 'field', value: 'food-cooking' }], {
      dailyBudgetMicros: budget,
      maxCpcMicros: 1_000_000,
    });
    const o = h.t.owner;
    const id = must(
      (await o.query<{ id: string }>('SELECT id::text FROM app.ad_campaigns WHERE public_id = $1', [live.campaign]))
        .rows[0],
    ).id;
    const creative = must(
      (await o.query<{ id: string }>('SELECT id::text FROM app.ad_creatives WHERE campaign_id = $1 LIMIT 1', [id]))
        .rows[0],
    ).id;
    await fc.assert(
      fc.asyncProperty(fc.array(fc.integer({ min: 0, max: 7 }), { minLength: 1, maxLength: 24 }), async plan => {
        const tokens = (
          await o.query<{ token: string }>(
            `INSERT INTO app.ad_impressions (campaign_id, creative_id, placement, price_micros)
             SELECT $1, $2, 'search', 700000 FROM generate_series(1, 8) RETURNING token::text`,
            [id, creative],
          )
        ).rows.map(r => r.token);
        // Duplicates and retries, some at the same moment.
        await Promise.all(plan.map(i => h.call('POST', `/ads/click/${must(tokens[i])}`)));
        const { rows } = await o.query<{ spent: string; over: number }>(
          `SELECT coalesce(sum(charged_micros), 0)::text AS spent,
                  count(*) FILTER (WHERE charged_micros > price_micros)::int AS over
           FROM app.ad_impressions WHERE campaign_id = $1 AND shown_at >= date_trunc('day', now(), 'UTC')`,
          [id],
        );
        expect(Number(must(rows[0]).spent)).toBeLessThanOrEqual(budget);
        expect(must(rows[0]).over).toBe(0);
      }),
      { numRuns: 15 },
    );
  });
});

describe('INVARIANT 3: the firewall', () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap(f => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
    });
  it('no knowledge module imports anything commercial, new platform code included', () => {
    const root = new URL('../src/', import.meta.url).pathname;
    const knowledge = ['search', 'recommendations', 'kg', 'intelligence'].flatMap(d => walk(join(root, d)));
    knowledge.push(
      ...['routing.ts', 'routing-score.ts', 'consensus.ts', 'reputation.ts', 'collusion.ts'].map(f => join(root, f)),
    );
    for (const file of knowledge) {
      const imports = [...readFileSync(file, 'utf8').matchAll(/from '([^']+)'/g)].map(m => m[1] ?? '');
      for (const i of imports) expect(`${file}: ${i}`).not.toMatch(/\/(ads|commerce)\//);
    }
    // And the database: consensus, trust and routing read no ad or commerce table.
    const sql = readFileSync(new URL('../../../db/migrations/0044_memory_and_governance.sql', import.meta.url), 'utf8');
    expect(sql).not.toMatch(/FROM app\.ad_/);
  });
  it('bids of any size change no search or question response', async () => {
    const asker = await w.member();
    const q = must(
      (
        await h.call('POST', '/questions', asker.token, {
          title: 'Which ferry runs to the islands in the monsoon?',
          field: 'travel',
        })
      ).json<{ question: { id: string } }>().question.id,
    );
    const read = async () => {
      const body = (await h.call('GET', `/questions/${q}`)).json<Record<string, unknown>>();
      return JSON.stringify(body);
    };
    const before = await read();
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1_000_000, max: 40_000_000 }), async bid => {
        await w.liveCampaign([{ kind: 'field', value: 'travel' }], { maxCpcMicros: bid });
        expect(await read()).toBe(before);
      }),
      { numRuns: 4 },
    );
  });
});

describe('owner views with data', () => {
  it('the dashboard shows totals, models and experiments, and no person', async () => {
    const boss = await w.member();
    await h.t.owner.query('INSERT INTO app.platform_owners (profile_id) VALUES ($1)', [boss.id]);
    await drainJournal(h.t.database, Buffer.alloc(32, 1));
    await commerceRollup(h.t.database, Buffer.alloc(32, 1), Date.now() + 86_400_000);
    const v = await recordPromoted(
      h.t.database,
      {
        name: 'owner-view',
        algorithm: 'test-model',
        params: {},
        dataset: { fingerprint: 'x' },
        metrics: { auc: 0.7 },
        baseline: {},
        reason: 'test',
        gitCommit: 'abcdef1',
        calibration: { x: [1], y: [1] },
      },
      Buffer.from('w'),
    );
    const res = await h.call('GET', '/owner/dashboard/summary', boss.token);
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      totals: { month: { questions: number } };
      models: Array<{ name: string; stage: string }>;
      audit: { brokenAt: number | null };
    }>();
    expect(body.totals.month.questions).toBeGreaterThan(0);
    expect(body.models.find(m => m.name === 'owner-view')?.stage).toBe('PRODUCTION');
    expect(body.audit.brokenAt).toBeNull();
    expect(JSON.stringify(body)).not.toContain(boss.id);
    expect((await h.call('GET', '/experiments/evaluate?experimentId=999999', boss.token)).json()).toEqual({
      found: false,
    });
    expect(await advanceStage(h.t.database, 'owner-view', v, { low: 0.1, high: 0.2, lowerIsBetter: false })).toBe(
      'held',
    );
    expect(await advanceStage(h.t.database, 'nothing', 1, { low: 0.1, high: 0.2, lowerIsBetter: false })).toBe(
      'missing',
    );
  });

  it('a candidate climbs the ladder only with evidence, one rung at a time, never to production', async () => {
    const o = h.t.owner;
    await o.query(
      "INSERT INTO app.ml_models (name, version, algorithm, params, dataset, metrics, baseline, status, reason) VALUES ('ladder', 1, 'test-model', '{}', '{}', '{}', '{}', 'rejected', 'r')",
    );
    await o.query("UPDATE app.ml_models SET stage = 'CANDIDATE' WHERE name = 'ladder'");
    const db = h.t.database;
    expect(await advanceStage(db, 'ladder', 1, { low: -0.1, high: 0.1, lowerIsBetter: false })).toBe('held');
    expect(await advanceStage(db, 'ladder', 1, { low: -0.2, high: -0.1, lowerIsBetter: true })).toBe('advanced');
    expect(await advanceStage(db, 'ladder', 1, { low: 0.1, high: 0.2, lowerIsBetter: false })).toBe('advanced');
    expect(await advanceStage(db, 'ladder', 1, { low: 0.1, high: 0.2, lowerIsBetter: false })).toBe('held');
    expect(
      must((await o.query<{ stage: string }>("SELECT stage FROM app.ml_models WHERE name = 'ladder'")).rows[0]).stage,
    ).toBe('CANARY');
  });

  it('a moderator works a complaint through, and a stranger can’t', async () => {
    const m = await w.member();
    await h.t.owner.query('INSERT INTO app.moderators (profile_id) VALUES ($1)', [m.id]);
    const p = await w.member();
    const g = (
      await h.call('POST', '/grievances', p.token, {
        kind: 'general',
        body: 'My answer was hidden and I don’t know why.',
      })
    ).json<{ grievance: { id: string } }>().grievance.id;
    const list = (await h.call('GET', '/ops/grievances', m.token)).json<{ rows: Array<{ id: string }> }>();
    expect(list.rows.some(r => r.id === g)).toBe(true);
    expect((await h.call('PATCH', `/ops/grievances/${g}`, m.token, { action: 'acknowledge' })).statusCode).toBe(200);
    expect((await h.call('PATCH', `/ops/grievances/${g}`, m.token, { action: 'resolve' })).statusCode).toBe(400);
    expect(
      (await h.call('PATCH', `/ops/grievances/${g}`, m.token, { action: 'resolve', outcome: 'Explained the reason.' }))
        .statusCode,
    ).toBe(200);
    expect((await h.call('PATCH', `/ops/grievances/${g}`, m.token, { action: 'acknowledge' })).statusCode).toBe(404);
    expect((await h.call('DELETE', '/me/memory', p.token)).json()).toEqual({ deleted: 0 });
  });
});
