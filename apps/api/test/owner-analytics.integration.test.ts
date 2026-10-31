// The owner's aggregates on real Postgres (ADR 0029).
import { beforeAll, describe, expect, it } from 'vitest';
import {
  answeringRollup,
  basketRollup,
  MIN_RULE_PEOPLE,
  retentionRates,
  retentionRollup,
} from '../src/olap/rollups.ts';
import { TDigest } from '../src/olap/sketches.ts';
import { startApp, type TestApp } from './helpers/app.ts';
import { must } from './helpers/must.ts';

let h: TestApp;
let names = 0;
beforeAll(async () => {
  h = await startApp(() => Date.now());
  return h.close;
});
async function member() {
  const p = await h.person();
  names += 1;
  const res = await h.call('POST', '/me/profile', p.token, {
    handle: `olap.${String(names)}`,
    country: 'IN',
    fields: ['travel'],
    adult: true,
  });
  expect(res.statusCode).toBe(201);
  await h.t.owner.query("UPDATE app.profiles SET created_at = now() - interval '2 days' WHERE id = $1", [p.id]);
  return p;
}
const insertQuestion = async (asker: string, title: string, daysAgo = 0) =>
  must(
    (
      await h.t.owner.query<{ id: string }>(
        `INSERT INTO app.questions (asker_id, field, title, created_at) VALUES ($1, 'travel', $2, now() - make_interval(days => $3)) RETURNING id::text`,
        [asker, title, daysAgo],
      )
    ).rows[0],
  ).id;

describe('retention', () => {
  it('counts distinct people per cohort week, and turns them into rates', async () => {
    const a = await member();
    const b = await member();
    await insertQuestion(a.id, 'Which ferry goes to the islands on Sundays?');
    await insertQuestion(a.id, 'Which bus goes to the islands on Sundays?');
    await retentionRollup(h.t.database);
    const { rows } = await h.t.owner.query<{
      cohort_week: string;
      week_offset: number;
      cohort_size: number;
      active: number;
    }>(`SELECT cohort_week::text AS cohort_week, week_offset, cohort_size, active FROM app.olap_cohort_retention`);
    const total = rows.reduce((s, r) => s + r.active, 0);
    // One person, two questions, in at most two calendar weeks: never counted per question beyond that.
    expect(total).toBeGreaterThanOrEqual(1);
    expect(total).toBeLessThanOrEqual(2);
    expect(rows.every(r => r.cohort_size >= 2 && r.active <= r.cohort_size)).toBe(true);
    expect(b.id).toBeTruthy();
    expect(JSON.stringify(rows)).not.toContain(a.id);
  });
  it('rates leave gaps as null and sort by week', () => {
    expect(
      retentionRates([
        { cohort_week: '2026-10-12', week_offset: 2, cohort_size: 50, active: 10 },
        { cohort_week: '2026-10-05', week_offset: 0, cohort_size: 40, active: 40 },
      ]),
    ).toEqual([
      { week: '2026-10-05', size: 40, weeks: [1] },
      { week: '2026-10-12', size: 50, weeks: [null, null, 0.2] },
    ]);
  });
});

describe('answering', () => {
  it('measures first answers and resolution, leaving out questions under 4 days old', async () => {
    const asker = await member();
    const answerer = await member();
    const old = await insertQuestion(asker.id, 'Is the old night ferry to the islands safe?', 10);
    await insertQuestion(asker.id, 'Is the new night ferry to the islands safe?', 1);
    const a = must(
      (
        await h.t.owner.query<{ id: string }>(
          `INSERT INTO app.answers (question_id, answerer_id, body, created_at)
           VALUES ($1, $2, 'Yes, I took it twice last June and it was fine.', (SELECT created_at + interval '60 minutes' FROM app.questions WHERE id = $1)) RETURNING id::text`,
          [old, answerer.id],
        )
      ).rows[0],
    ).id;
    await h.t.owner.query("SET session_replication_role = 'replica'");
    await h.t.owner.query(
      `INSERT INTO app.helpful_marks (answer_id, marked_at) VALUES ($1, (SELECT created_at + interval '1 day' FROM app.questions WHERE id = $2))`,
      [a, old],
    );
    await h.t.owner.query("SET session_replication_role = 'origin'");
    await answeringRollup(h.t.database);
    const { rows } = await h.t.owner.query<{
      questions: number;
      resolved_4d: number;
      answered: number;
      tdigest_minutes: Buffer;
    }>(
      "SELECT questions, resolved_4d, answered, tdigest_minutes FROM app.olap_daily_answering WHERE field_id = 'travel'",
    );
    expect(rows).toHaveLength(1);
    const r = must(rows[0]);
    expect(r).toMatchObject({ questions: 1, resolved_4d: 1, answered: 1 });
    expect(TDigest.fromBytes(r.tdigest_minutes).quantile(0.5)).toBeCloseTo(60, 0);
  });
});

describe('basket rules', () => {
  const titles = [
    'Does the Samsung Galaxy S24 work with this charger?',
    'Is the Sony WH1000 good for long flights abroad?',
  ];
  it('needs 25 distinct people, counts each person once, and keeps nobody', async () => {
    // Others asking about something else: without them, asking about both is no more than chance.
    for (const p of await Promise.all(Array.from({ length: 30 }, () => member())))
      await insertQuestion(p.id, 'Is the Dell XPS 13 good for long flights abroad?');
    const few = await Promise.all(Array.from({ length: MIN_RULE_PEOPLE - 1 }, () => member()));
    for (const p of few) for (const t of titles) await insertQuestion(p.id, t);
    // One person asking many times can't reach the floor.
    for (let i = 0; i < 40; i++) await insertQuestion(must(few[0]).id, `${must(titles[0])} ${String(i)}`.slice(0, 150));
    await basketRollup(h.t.database);
    const count = async () => (await h.t.owner.query('SELECT 1 FROM app.olap_commerce_rules')).rowCount;
    expect(await count()).toBe(0);
    const last = await member();
    for (const t of titles) await insertQuestion(last.id, t);
    await basketRollup(h.t.database);
    const { rows } = await h.t.owner.query<{ people: number; confidence: number }>(
      'SELECT people, confidence FROM app.olap_commerce_rules',
    );
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(must(rows[0]).people).toBe(MIN_RULE_PEOPLE);
  });
});

describe('who can read', () => {
  it('only the owner page and the system: nobody else, directly', async () => {
    const p = await member();
    await h.t.owner.query(
      `INSERT INTO app.olap_cohort_retention (cohort_week, week_offset, cohort_size, active) VALUES ('2026-01-05', 0, 30, 30) ON CONFLICT DO NOTHING`,
    );
    const seen = await h.t.database.withUser(
      p.id,
      async q => (await q.query('SELECT 1 FROM app.olap_cohort_retention')).rowCount,
    );
    expect(seen).toBe(0);
    await expect(
      h.t.database.withUser(p.id, q =>
        q.query(
          `INSERT INTO app.olap_cohort_retention (cohort_week, week_offset, cohort_size, active) VALUES ('2026-02-02', 0, 1, 1)`,
        ),
      ),
    ).rejects.toThrow();
    expect((await h.call('GET', '/owner/dashboard/summary', p.token)).statusCode).toBe(403);
    await h.t.owner.query('INSERT INTO app.platform_owners (profile_id) VALUES ($1)', [p.id]);
    const res = await h.call('GET', '/owner/dashboard/summary', p.token);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json<{ answering: unknown; retention: unknown[]; together: unknown[] }>();
    expect(body.answering).toBeTruthy();
    expect(Array.isArray(body.retention)).toBe(true);
    expect(Array.isArray(body.together)).toBe(true);
  });
});
