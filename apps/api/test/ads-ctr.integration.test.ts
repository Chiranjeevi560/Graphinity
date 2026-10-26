// The ad click model's daily job on a real database (ADR 0022 part 5): it
// waits for enough impressions and clicks, learns from them in time order,
// is promoted through the registry only when it beats what serves, and the
// ad server then serves with it.
import { beforeAll, describe, expect, it } from 'vitest';
import { AD_CTR, MIN_CLICKS, MIN_IMPRESSIONS, trainAdCtrJob } from '../src/ads/ctr.ts';
import { loadServing } from '../src/ml/registry.ts';
import { createTestDatabase, type TestDatabase } from './helpers/database.ts';
import { must } from './helpers/must.ts';

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase();
  return () => t.close();
});

/** One business with `n` campaigns, each with one approved ad; returns their ids. */
async function campaigns(n: number) {
  await t.owner.query("SET session_replication_role = 'replica'");
  try {
    const adv = must(
      (
        await t.owner.query<{ id: string }>(
          "INSERT INTO app.ad_advertisers (name, country, status) VALUES ('Ferries', 'IN', 'active') RETURNING id::text",
        )
      ).rows[0],
    ).id;
    const out: Array<{ campaign: string; creative: string }> = [];
    for (let i = 0; i < n; i++) {
      const c = must(
        (
          await t.owner.query<{ id: string }>(
            `INSERT INTO app.ad_campaigns (advertiser_id, name, objective, status, daily_budget_micros, max_cpc_micros)
             VALUES ($1, $2, 'clicks', 'active', 100000000, 1000000) RETURNING id::text`,
            [adv, `Campaign ${String(i)}`],
          )
        ).rows[0],
      ).id;
      const cr = must(
        (
          await t.owner.query<{ id: string }>(
            `INSERT INTO app.ad_creatives (campaign_id, headline, body, destination_url, status, reviewed_at)
             VALUES ($1, 'Ferries to the islands', 'Daily boats from Panaji, book a seat.', 'https://ferries.example.in', 'approved', now())
             RETURNING id::text`,
            [c],
          )
        ).rows[0],
      ).id;
      out.push({ campaign: c, creative: cr });
    }
    return out;
  } finally {
    await t.owner.query("SET session_replication_role = 'origin'");
  }
}

/**
 * Impressions over the last week, in time order: each campaign is clicked far more on its own
 * topic (travel for even campaigns, money-tax for odd ones) than elsewhere.
 */
async function impressions(cs: Array<{ campaign: string; creative: string }>, n: number) {
  await t.owner.query(
    `INSERT INTO app.ad_impressions (campaign_id, creative_id, placement, price_micros, field, shown_at, clicked_at)
     SELECT c.campaign, c.creative, CASE WHEN g % 2 = 0 THEN 'search' ELSE 'question' END, 100000, f.field,
            now() - interval '7 days' + (g * interval '1 second'),
            CASE WHEN random() < CASE WHEN (c.idx % 2 = 0) = (f.field = 'travel') THEN 0.12 ELSE 0.01 END
                 THEN now() - interval '7 days' + (g * interval '1 second') END
     FROM generate_series(1, $1) AS g
     CROSS JOIN LATERAL (SELECT (array['travel', 'money-tax'])[1 + (g / 7) % 2] AS field) f
     CROSS JOIN LATERAL (
       SELECT x.campaign::bigint AS campaign, x.creative::bigint AS creative, x.idx
       FROM jsonb_to_recordset($2::jsonb) AS x(campaign text, creative text, idx int)
       WHERE x.idx = g % $3
     ) c`,
    [n, JSON.stringify(cs.map((c, idx) => ({ ...c, idx }))), cs.length],
  );
}

describe('the ad click model', () => {
  it('waits for enough impressions and clicks', async () => {
    // Some, but far from enough.
    await impressions(await campaigns(2), 500);
    const outcome = await trainAdCtrJob(t.database);
    expect(outcome).toMatchObject({ status: 'skipped' });
    expect(outcome.status === 'skipped' && outcome.reason).toContain(String(MIN_IMPRESSIONS));
    expect(MIN_CLICKS).toBeGreaterThan(0);
  });

  it('learns what a per-campaign average misses, is promoted, and serves with its weights checked', async () => {
    const cs = await campaigns(20);
    await impressions(cs, 30_000);
    const outcome = await trainAdCtrJob(t.database);
    expect(outcome.status).toBe('promoted');
    if (outcome.status !== 'promoted') return;
    expect(outcome.result.difference.high).toBeLessThan(0);
    const serving = must(await loadServing(t.database, AD_CTR));
    expect(serving.version).toBe(outcome.version);
    const { rows } = await t.owner.query<{ baseline: { kind: string } }>(
      "SELECT baseline FROM app.ml_models WHERE name = 'ad-ctr' AND version = $1",
      [outcome.version],
    );
    expect(rows[0]?.baseline.kind).toBe('shrunk');
    // The next run is judged against the model now serving, not the averages.
    const again = await trainAdCtrJob(t.database);
    expect(again.status).not.toBe('skipped');
    if (again.status === 'skipped') return;
    const next = await t.owner.query<{ baseline: { kind: string; version: number } }>(
      "SELECT baseline FROM app.ml_models WHERE name = 'ad-ctr' AND version = $1",
      [again.version],
    );
    expect(next.rows[0]?.baseline).toMatchObject({ kind: 'model', version: outcome.version });
    // And judged by that model's predictions: better than the averages the first run was judged by.
    expect(again.result.baselineLogLoss).toBeLessThan(outcome.result.baselineLogLoss);
  });
});
