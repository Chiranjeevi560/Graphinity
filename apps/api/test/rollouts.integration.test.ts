// Rollout rings and the governor, through the real server and Postgres (ADR 0028).
import { beforeAll, describe, expect, it } from 'vitest';
import { createFlags } from '../src/flags.ts';
import { runRolloutGovernor } from '../src/governance/rollout-job.ts';
import { inRing } from '../src/governance/rollback.ts';
import { startApp, type TestApp } from './helpers/app.ts';

let h: TestApp;
let names = 0;
beforeAll(async () => {
  h = await startApp(() => Date.now());
  return h.close;
});

async function member() {
  const p = await h.person();
  names += 1;
  await h.call('POST', '/me/profile', p.token, {
    handle: `ring.${String(names)}`,
    country: 'IN',
    fields: ['travel'],
    adult: true,
  });
  return p;
}
async function owner() {
  const p = await member();
  await h.t.owner.query('INSERT INTO app.platform_owners (profile_id) VALUES ($1)', [p.id]);
  return p;
}
const flag = async (name: string) =>
  (
    await h.t.owner.query<{ enabled: boolean; ring: number | null; tripped: boolean }>(
      'SELECT enabled, ring, tripped_at IS NOT NULL AS tripped FROM app.feature_flags WHERE name = $1',
      [name],
    )
  ).rows[0];
const traffic = async (requests: number, errors: number) => {
  await h.t.owner.query("DELETE FROM app.ops_minutes WHERE route = '/test'");
  await h.t.owner.query(
    `INSERT INTO app.ops_minutes (minute, method, route, requests, errors, slow, total_ms, buckets)
     VALUES (date_trunc('minute', now()), 'GET', '/test', $1, $2, 0, 0, '{}')`,
    [requests, errors],
  );
};

describe('moving rings', () => {
  it('only an owner may, in the API and the database', async () => {
    const p = await member();
    expect((await h.call('POST', '/owner/rollouts', p.token, { flag: 'ads_pacing', ring: 0 })).statusCode).toBe(403);
    await expect(
      h.t.database.withUser(p.id, q => q.query("SELECT app.set_flag_ring('ads_pacing', 0::smallint)")),
    ).rejects.toThrow(/only an owner/);
    await expect(h.t.database.withUser(p.id, q => q.query('SELECT app.trip_rollouts()'))).rejects.toThrow(
      /only the governor/,
    );
    expect(await flag('ads_pacing')).toMatchObject({ enabled: false, ring: null });
  });

  it('turns a switch on for its ring; ring 3 is everyone', async () => {
    const o = await owner();
    const res = await h.call('POST', '/owner/rollouts', o.token, { flag: 'ads_holdout', ring: 1 });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ rollout: { flag: 'ads_holdout', percent: 5 } });
    expect(await flag('ads_holdout')).toMatchObject({ enabled: true, ring: 1 });
    const flags = createFlags(h.t.database);
    await flags.refresh();
    const people = Array.from({ length: 2000 }, (_, i) => `p${String(i)}`);
    expect(people.every(p => flags.enabledFor('ads_holdout', p) === inRing('ads_holdout', p, 1))).toBe(true);
    expect(flags.enabled('ads_holdout')).toBe(true);
    expect((await h.call('POST', '/owner/rollouts', o.token, { flag: 'ads_holdout', ring: 3 })).statusCode).toBe(200);
    await flags.refresh();
    expect(people.every(p => flags.enabledFor('ads_holdout', p))).toBe(true);
    flags.stop();
    expect((await h.call('POST', '/owner/rollouts', o.token, { flag: 'no_such_flag', ring: 0 })).statusCode).toBe(404);
    expect((await h.call('POST', '/owner/rollouts', o.token, { flag: 'ads_holdout', ring: 4 })).statusCode).toBe(400);
    await h.t.owner.query("UPDATE app.feature_flags SET enabled = false WHERE name = 'ads_holdout'");
  });
});

describe('the governor', () => {
  it('leaves everything alone while healthy, then turns off only what is in a ring, and says so', async () => {
    const o = await owner();
    await h.call('POST', '/owner/rollouts', o.token, { flag: 'ads_rtb', ring: 0 });
    await traffic(1000, 2);
    expect(await runRolloutGovernor(h.t.database)).toEqual([]);
    expect(await flag('ads_rtb')).toMatchObject({ enabled: true, ring: 0 });

    await traffic(1000, 200);
    expect(await runRolloutGovernor(h.t.database)).toEqual(['ads_rtb']);
    expect(await flag('ads_rtb')).toEqual({ enabled: false, ring: null, tripped: true });
    // Switches not in a ring are never touched.
    expect(await flag('search')).toMatchObject({ enabled: true });
    const { rows } = await h.t.owner.query(
      "SELECT 1 FROM app.audit_log WHERE action = 'rollout.tripped' AND subject = 'ads_rtb'",
    );
    expect(rows).toHaveLength(1);
    // The next pass finds nothing left to do.
    expect(await runRolloutGovernor(h.t.database)).toEqual([]);
  });

  it('never switches off the security check, however bad the errors', async () => {
    await h.t.owner.query("UPDATE app.feature_flags SET enabled = true, ring = 0 WHERE name = 'step_up_auth'");
    await traffic(1000, 200);
    expect(await runRolloutGovernor(h.t.database)).not.toContain('step_up_auth');
    expect(await flag('step_up_auth')).toMatchObject({ enabled: true });
    await h.t.owner.query("UPDATE app.feature_flags SET enabled = false, ring = NULL WHERE name = 'step_up_auth'");
  });

  it('shows on the status page and reaches moderators', async () => {
    const mod = await member();
    await h.t.owner.query('INSERT INTO app.moderators (profile_id) VALUES ($1)', [mod.id]);
    const status = (await h.call('GET', '/ops/status', mod.token)).json<{
      rollouts: Array<{ name: string; trippedAt: string | null }>;
    }>();
    expect(status.rollouts.find(r => r.name === 'ads_rtb')?.trippedAt).toBeTruthy();
  });
});
