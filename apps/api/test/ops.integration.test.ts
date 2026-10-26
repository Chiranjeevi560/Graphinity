// Operations data on a real database (ADR 0020, migration 0027): minutes add
// up, the database refuses rows that would break the SLO maths, jobs record
// their runs, the status reads windows, alerts and job health back, and
// only moderators and the server's own jobs can see any of it. Through the
// real server: every response is counted by route pattern.
import { beforeAll, describe, expect, it } from 'vitest';
import { BUCKETS_MS, bucketOf, createRecorder, type RouteMinute } from '../src/ops/metrics.ts';
import { COOLDOWN_HOURS, dueProblems, moderatorIds, problemsOf, type Problem } from '../src/ops/alerts.ts';
import { compactMinutes, JOB_LABELS, loadStatus, recordedRun, saveMinute, type OpsStatus } from '../src/ops/store.ts';
import { startApp, type TestApp } from './helpers/app.ts';
import { must, type Body } from './helpers/must.ts';

let h: TestApp;
const metrics = createRecorder();

beforeAll(async () => {
  h = await startApp(() => Date.now(), { metrics });
  return h.close;
});

const minute = (route: string, requests: number, errors = 0, slow = 0, method = 'GET'): RouteMinute => {
  const buckets = new Array<number>(BUCKETS_MS.length + 1).fill(0);
  buckets[bucketOf(20)] = requests - slow;
  buckets[bucketOf(600)] = slow;
  return { route, method, requests, errors, slow, totalMs: requests * 20, buckets };
};
const save = (at: Date, rows: RouteMinute[]) => h.t.database.asSystem(q => saveMinute(q, at, rows));
const status = () => h.t.database.asSystem(q => loadStatus(q));
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

describe('request minutes', () => {
  it('add up when the same minute is flushed twice, histograms included', async () => {
    const at = minutesAgo(3);
    await save(at, [minute('/adds/:id', 10, 1)]);
    await save(at, [minute('/adds/:id', 5, 0, 2)]);
    const { rows } = await h.t.owner.query<{ requests: number; errors: number; slow: number; buckets: number[] }>(
      "SELECT requests, errors, slow, buckets FROM app.ops_minutes WHERE route = '/adds/:id'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ requests: 15, errors: 1, slow: 2 });
    expect(rows[0]?.buckets[bucketOf(20)]).toBe(13);
    expect(rows[0]?.buckets[bucketOf(600)]).toBe(2);
  });

  it('roll up into hours after two days, keeping every count and the histogram', async () => {
    await h.t.owner.query('DELETE FROM app.ops_minutes');
    // Three minutes in one hour three days ago, one in the next hour, and one recent minute.
    const hour = new Date(Math.floor((Date.now() - 3 * 86_400_000) / 3_600_000) * 3_600_000);
    const at = (m: number) => new Date(hour.getTime() + m * 60_000);
    await save(at(1), [minute('/roll', 10, 1, 2)]);
    await save(at(2), [minute('/roll', 20, 0, 1)]);
    await save(at(59), [minute('/roll', 5)]);
    await save(at(61), [minute('/roll', 7, 7)]);
    await save(minutesAgo(5), [minute('/roll', 3)]);
    const before = await status();
    await h.t.database.asSystem(q => compactMinutes(q));
    const { rows } = await h.t.owner.query<{
      span: number;
      requests: number;
      errors: number;
      slow: number;
      buckets: number[];
    }>("SELECT span, requests, errors, slow, buckets FROM app.ops_minutes WHERE route = '/roll' ORDER BY minute");
    expect(rows.map(r => [r.span, r.requests, r.errors, r.slow])).toEqual([
      [60, 35, 1, 3],
      [60, 7, 7, 0],
      [1, 3, 0, 0],
    ]);
    expect(rows[0]?.buckets[bucketOf(20)]).toBe(32);
    expect(rows[0]?.buckets[bucketOf(600)]).toBe(3);
    // The 30-day picture is the same after compaction.
    expect((await status()).objectives).toEqual(before.objectives);
    // Compacting again changes nothing.
    await h.t.database.asSystem(q => compactMinutes(q));
    expect((await h.t.owner.query("SELECT 1 FROM app.ops_minutes WHERE route = '/roll'")).rowCount).toBe(3);
    // A minute crossing the line later adds into its existing hour, histogram included.
    await save(at(30), [minute('/roll', 4, 0, 4)]);
    await h.t.database.asSystem(q => compactMinutes(q));
    const hourRow = (
      await h.t.owner.query<{ requests: number; buckets: number[] }>(
        "SELECT requests, buckets FROM app.ops_minutes WHERE route = '/roll' AND span = 60 ORDER BY minute LIMIT 1",
      )
    ).rows[0];
    expect(hourRow?.requests).toBe(39);
    expect(hourRow?.buckets[bucketOf(600)]).toBe(7);
    expect(hourRow?.buckets[bucketOf(20)]).toBe(32);
  });

  it('are refused when they would break the maths', async () => {
    const bad = (row: Partial<RouteMinute>) => save(new Date(), [{ ...minute('/x', 2), ...row }]);
    await expect(bad({ errors: 3 })).rejects.toThrow();
    await expect(bad({ route: '/a?b=c' })).rejects.toThrow();
    await expect(bad({ method: 'BREW' })).rejects.toThrow();
    await expect(bad({ buckets: [1, 1] })).rejects.toThrow();
    await expect(bad({ requests: 0, errors: 0, slow: 0 })).rejects.toThrow();
  });

  it('expire after the retention, and only the server may write or delete them', async () => {
    await save(new Date(Date.now() - 36 * 86_400_000), [minute('/old', 1)]);
    expect(await h.t.database.asSystem(q => compactMinutes(q))).toBeGreaterThanOrEqual(1);
    const left = await h.t.owner.query("SELECT 1 FROM app.ops_minutes WHERE route = '/old'");
    expect(left.rowCount).toBe(0);
    // Not even the server's own jobs may delete a recent minute.
    await save(new Date(), [minute('/recent', 1)]);
    expect(
      await h.t.database.asSystem(
        async q => (await q.query("DELETE FROM app.ops_minutes WHERE route = '/recent'")).rowCount,
      ),
    ).toBe(0);
    const someone = await h.person();
    await expect(
      h.t.database.withUser(someone.id, q => saveMinute(q, new Date(), [minute('/x', 1)])),
    ).rejects.toThrow();
    // A plain insert too, not only the server's upsert.
    await expect(
      h.t.database.withUser(someone.id, q =>
        q.query(
          "INSERT INTO app.ops_minutes (minute, method, route, requests, errors, slow, total_ms, buckets) VALUES (date_trunc('minute', now()), 'GET', '/x', 1, 0, 0, 1, array_fill(0, ARRAY[30]))",
        ),
      ),
    ).rejects.toThrow();
    expect(
      await h.t.database.withUser(someone.id, async q => (await q.query('SELECT 1 FROM app.ops_minutes')).rowCount),
    ).toBe(0);
  });
});

describe('the status', () => {
  it('computes each objective over 30 days, leaving the live stream out', async () => {
    await h.t.owner.query('DELETE FROM app.ops_minutes');
    await save(minutesAgo(10), [minute('/answers/:id', 1000, 2, 30), minute('/events', 50, 50, 50)]);
    const s = await status();
    const availability = must(s.objectives.find(o => o.name === 'availability'));
    expect(availability.good).toBeCloseTo(0.998, 12);
    // 2 failures of a 5-per-1000 budget: 60% left.
    expect(availability.budgetRemaining).toBeCloseTo(0.6, 12);
    expect(must(s.objectives.find(o => o.name === 'latency')).good).toBeCloseTo(0.97, 12);
    expect(s.routes.map(r => r.route)).toEqual(['/answers/:id']);
    expect(s.routes[0]?.p50).toBeGreaterThan(10);
    expect(s.alerts).toEqual([]);
  });

  it('pages when the last hour and the last five minutes both burn the budget fast', async () => {
    await h.t.owner.query('DELETE FROM app.ops_minutes');
    await save(minutesAgo(30), [minute('/questions', 400, 40)]);
    await save(minutesAgo(1), [minute('/questions', 100, 10)]);
    const s = await status();
    expect(s.alerts[0]).toMatchObject({ objective: 'availability', severity: 'page', long: 60, short: 5 });
  });

  it('shows a job that failed last, or stopped running, as unhealthy', async () => {
    await expect(
      recordedRun(h.t.database, 'test-fails', 60, () => Promise.reject(new RangeError('boom'))),
    ).rejects.toThrow('boom');
    expect(await recordedRun(h.t.database, 'test-works', 60, () => Promise.resolve(7))).toBe(7);
    await recordedRun(h.t.database, 'test-stopped', 60, () => Promise.resolve(1));
    await h.t.owner.query(
      "UPDATE app.ops_jobs SET last_started_at = now() - interval '3 minutes', last_success_at = now() - interval '3 minutes' WHERE job = 'test-stopped'",
    );
    const jobs = (await status()).jobs.filter(j => j.job.startsWith('test-'));
    // Each job says what it does; one never named falls back to its id.
    expect((await status()).jobs.find(j => j.job === 'test-works')?.label).toBe('test-works');
    expect(jobs.map(j => [j.job, j.healthy, j.runs, j.failures, j.lastErrorKind])).toEqual([
      ['test-fails', false, 1, 1, 'RangeError'],
      ['test-stopped', false, 1, 0, null],
      ['test-works', true, 1, 0, null],
    ]);
    // An error whose kind isn't a plain class name is recorded as 'unknown', never verbatim.
    const odd = Object.assign(new Error('a message with data'), { name: 'not a class name' });
    await expect(recordedRun(h.t.database, 'test-odd', 60, () => Promise.reject(odd))).rejects.toBe(odd);
    expect((await status()).jobs.find(j => j.job === 'test-odd')?.lastErrorKind).toBe('unknown');
    // A database that can't take the record never stops the job.
    const down = { asSystem: () => Promise.reject(new Error('down')) };
    expect(await recordedRun(down, 'test-down', 60, () => Promise.resolve('ran'))).toBe('ran');
    // Succeeding again makes it healthy.
    await recordedRun(h.t.database, 'test-fails', 60, () => Promise.resolve(0));
    expect((await status()).jobs.find(j => j.job === 'test-fails')).toMatchObject({
      healthy: true,
      runs: 2,
      failures: 1,
    });
  });
});

describe('the operations page', () => {
  it('is for moderators only', async () => {
    const someone = await h.person();
    expect((await h.call('GET', '/ops/status', someone.token)).json<Body>().error).toBe('not_a_moderator');
    expect((await h.call('GET', '/ops/status')).statusCode).toBe(401);
    const mod = await h.person();
    expect(
      (
        await h.call('POST', '/me/profile', mod.token, {
          handle: 'ops.mod',
          country: 'IN',
          fields: ['travel'],
          adult: true,
        })
      ).statusCode,
    ).toBe(201);
    await h.t.owner.query('INSERT INTO app.moderators (profile_id) VALUES ($1)', [mod.id]);
    const res = await h.call('GET', '/ops/status', mod.token);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<{ objectives: unknown[]; jobs: unknown[] }>().objectives).toHaveLength(2);
  });

  it('counts every response by route pattern, never the address', async () => {
    metrics.flush();
    await h.call('GET', '/questions/123456');
    await h.call('GET', '/questions/654321');
    await h.call('GET', '/no/such/place');
    const rows = metrics.flush();
    const question = rows.find(r => r.route === '/questions/:id');
    expect(question).toMatchObject({ method: 'GET', requests: 2 });
    expect(rows.find(r => r.route === 'unmatched')).toMatchObject({ requests: 1 });
    expect(JSON.stringify(rows)).not.toContain('123456');
  });
});

describe('alerts', () => {
  const job = (name: string, over: Partial<OpsStatus['jobs'][number]> = {}): OpsStatus['jobs'][number] => ({
    job: name,
    label: JOB_LABELS[name] ?? name,
    expectedSeconds: 60,
    lastSuccessAt: '2026-10-26T10:00:00.000Z',
    lastFailureAt: null,
    lastErrorKind: null,
    runs: 1,
    failures: 0,
    healthy: true,
    ...over,
  });
  const base: OpsStatus = { objectives: [], alerts: [], routes: [], jobs: [] };

  it('come from page alerts and unhealthy jobs only, in plain words', () => {
    const problems = problemsOf({
      ...base,
      alerts: [
        { objective: 'availability', severity: 'page', long: 60, short: 5, burnLong: 20.4, burnShort: 30 },
        { objective: 'latency', severity: 'ticket', long: 1440, short: 120, burnLong: 3.5, burnShort: 4 },
      ],
      jobs: [
        job('routing', { healthy: false, lastFailureAt: '2026-10-26T11:00:00.000Z', lastErrorKind: 'TimeoutError' }),
        job('training', { healthy: false }),
        job('deletions'),
      ],
    });
    expect(problems.map(p => p.key)).toEqual(['slo:availability:60', 'job:routing', 'job:training']);
    expect(problems[0]?.body).toContain('20 times too fast over the last 1 hours');
    expect(problems[1]).toMatchObject({ title: 'Sending questions to people isn’t working' });
    expect(problems[1]?.body).toContain('(TimeoutError)');
    expect(problems[2]?.body).toContain('twice its usual time');
  });

  it('are sent once, again only after the cooldown, and anew when a cleared problem returns', async () => {
    await h.t.owner.query('DELETE FROM app.ops_alerts');
    const p: Problem = { key: 'job:routing', title: 't', body: 'b' };
    const q: Problem = { key: 'slo:latency:60', title: 't', body: 'b' };
    const due = (problems: Problem[]) => h.t.database.asSystem(tx => dueProblems(tx, problems));
    expect((await due([p])).map(x => x.key)).toEqual(['job:routing']);
    expect(await due([p])).toEqual([]);
    // Still going after the cooldown: said again.
    await h.t.owner.query(`UPDATE app.ops_alerts SET last_sent_at = now() - make_interval(hours => $1)`, [
      COOLDOWN_HOURS + 1,
    ]);
    expect((await due([p, q])).map(x => x.key)).toEqual(['job:routing', 'slo:latency:60']);
    // It clears, then comes back: news again, at once.
    expect(await due([q])).toEqual([]);
    const { rows } = await h.t.owner.query<{ resolved: boolean }>(
      "SELECT resolved_at IS NOT NULL AS resolved FROM app.ops_alerts WHERE key = 'job:routing'",
    );
    expect(rows[0]?.resolved).toBe(true);
    expect((await due([p, q])).map(x => x.key)).toEqual(['job:routing']);
  });

  it('go to every moderator who isn’t blocked, and only the server can keep their record', async () => {
    const [a, b, c] = [await h.person(), await h.person(), await h.person()];
    let n = 0;
    for (const x of [a, b, c]) {
      n += 1;
      await h.call('POST', '/me/profile', x.token, {
        handle: `alert.${String(n)}`,
        country: 'IN',
        fields: ['travel'],
        adult: true,
      });
    }
    await h.t.owner.query('INSERT INTO app.moderators (profile_id) VALUES ($1), ($2)', [a.id, b.id]);
    await h.t.owner.query('INSERT INTO app.blocks (profile_id) VALUES ($1)', [b.id]);
    const ids = await h.t.database.asSystem(q => moderatorIds(q));
    expect(ids).toContain(a.id);
    expect(ids).not.toContain(b.id);
    expect(ids).not.toContain(c.id);
    await expect(
      h.t.database.withUser(a.id, q => q.query("INSERT INTO app.ops_alerts (key) VALUES ('job:routing-x')")),
    ).rejects.toThrow();
    expect(await h.t.database.withUser(a.id, async q => (await q.query('SELECT 1 FROM app.ops_alerts')).rowCount)).toBe(
      0,
    );
  });
});
