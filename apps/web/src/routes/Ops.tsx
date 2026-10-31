import { useState } from 'react';
import { LoadFailed } from '../components/Message.tsx';
import { timeAgo } from '../lib/questions.ts';
import { useLoad } from '../use-load.ts';

interface Status {
  objectives: Array<{
    name: 'availability' | 'latency';
    target: number;
    good: number | null;
    budgetRemaining: number;
    burn: { hour: number; day: number };
  }>;
  alerts: Array<{
    objective: 'availability' | 'latency';
    severity: 'page' | 'ticket';
    long: number;
    burnLong: number;
  }>;
  routes: Array<{ method: string; route: string; requests: number; errors: number; p95: number | null }>;
  jobs: Array<{
    job: string;
    label: string;
    expectedSeconds: number;
    lastSuccessAt: string | null;
    lastFailureAt: string | null;
    lastErrorKind: string | null;
    healthy: boolean;
  }>;
}

const objectiveWords = {
  availability: 'Requests that worked',
  latency: 'Answered within half a second',
} as const;

const percent = (x: number, digits = 1) => `${(x * 100).toFixed(digits)}%`;
const count = new Intl.NumberFormat('en');
const windowWords = (minutes: number) =>
  minutes < 60
    ? `${String(minutes)} minutes`
    : minutes < 1440
      ? `${String(minutes / 60)} hours`
      : `${String(minutes / 1440)} days`;

const Note = ({ text }: { text: string }) => (
  <main className="page stack-message">
    <p className="text-body status" role="status">
      {text}
    </p>
  </main>
);

/** For moderators: whether Graphinity is working as it should, in plain words. */
export default function OpsPage() {
  const { data: status, error, retry } = useLoad<Status>('/ops/status', true);
  // Times are "5 minutes ago" as of loading; reloading the page brings them up to date.
  const [now] = useState(Date.now);
  if (error) return <LoadFailed error={error} onRetry={retry} />;
  if (!status) return <Note text="Loading…" />;
  const pages = status.alerts.filter(a => a.severity === 'page');
  const unhealthy = status.jobs.filter(j => !j.healthy);
  const calm = pages.length === 0 && unhealthy.length === 0;

  return (
    <main className="page review">
      <h1 className="text-title1">Operations</h1>

      <section className="review-section" aria-labelledby="now-heading">
        <h2 id="now-heading" className="text-title3">
          Right now
        </h2>
        {calm ? (
          <p className="text-body ops-calm">Everything is working within its objectives.</p>
        ) : (
          <ul className="review-list">
            {pages.map(a => (
              <li key={`${a.objective}:${String(a.long)}`} className="review-item">
                <p className="text-body ops-problem">
                  {a.objective === 'availability' ? 'Requests are failing' : 'Requests are slow'}, using up a month’s
                  allowance {String(Math.round(a.burnLong))} times too fast over the last {windowWords(a.long)}.
                </p>
                <p className="text-subhead secondary">
                  Look at the slowest routes below and at the server’s logs. If it started after a deploy, roll back.
                </p>
              </li>
            ))}
            {unhealthy.map(j => (
              <li key={j.job} className="review-item">
                <p className="text-body ops-problem">
                  {j.label}:{' '}
                  {j.lastFailureAt && (!j.lastSuccessAt || j.lastFailureAt > j.lastSuccessAt)
                    ? `failed ${timeAgo(j.lastFailureAt, now)}${j.lastErrorKind ? ` (${j.lastErrorKind})` : ''}.`
                    : `hasn’t worked since ${j.lastSuccessAt ? timeAgo(j.lastSuccessAt, now) : 'it started'}.`}
                </p>
                <p className="text-subhead secondary">Its log lines say what went wrong.</p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <Section
        title="The last 30 days"
        empty=""
        rows={status.objectives.map(o => [
          objectiveWords[o.name],
          o.good === null
            ? 'No requests yet'
            : `${percent(o.good, 2)}, against a goal of ${percent(o.target)} · ${
                o.budgetRemaining < 0
                  ? 'allowance used up'
                  : `${percent(Math.min(1, o.budgetRemaining), 0)} of the allowance left`
              }`,
          o.good !== null && o.budgetRemaining < 0,
        ])}
      />
      <p className="text-footnote secondary">
        The allowance is how many requests may fail, or be slow, in 30 days while still meeting the objective.
      </p>

      <Section
        title="Background work"
        empty="Nothing has run yet."
        rows={status.jobs.map(j => [
          j.label,
          j.lastFailureAt && (!j.lastSuccessAt || j.lastFailureAt > j.lastSuccessAt)
            ? `Failed ${timeAgo(j.lastFailureAt, now)}`
            : j.lastSuccessAt
              ? `Worked ${timeAgo(j.lastSuccessAt, now)}`
              : 'Not worked yet',
          !j.healthy,
        ])}
      />
      <Section
        title="Slowest requests today"
        empty="No requests today."
        rows={status.routes.map(r => [
          `${r.method} ${r.route}`,
          `${count.format(r.requests)} ${r.requests === 1 ? 'request' : 'requests'}${r.p95 === null ? '' : ` · 95% within ${count.format(Math.round(r.p95))} ms`}${r.errors > 0 ? ` · ${count.format(r.errors)} failed` : ''}`,
          r.errors > 0,
        ])}
      />
    </main>
  );
}

interface Period {
  questions: number;
  answers: number;
}

interface Summary {
  totals: { day: Period; week: Period; month: Period };
  models: Array<{ name: string; version: number; stage: string; algorithm: string }>;
  experiments: Array<{ name: string; status: string; p: number }>;
  commerce: Array<{ label: string; count: number; forecast: number | null }>;
  audit: { entries: number; brokenAt: number | null };
}

type Row = [name: string, figures: string, problem?: boolean];

const n = (x: number) => count.format(Math.round(x));
const period = (name: string, p: Period): Row => [name, `${n(p.questions)} questions · ${n(p.answers)} answers`];

function Section({ title, rows, empty }: { title: string; rows: Row[]; empty: string }) {
  return (
    <section className="review-section">
      <h2 className="text-title3">{title}</h2>
      {rows.length === 0 ? (
        <p className="text-body secondary">{empty}</p>
      ) : (
        <ul className="standing-list">
          {rows.map(([name, figures, problem]) => (
            <li key={name} className="standing-row ops-row">
              <span className="text-body">{name}</span>
              <span className={`text-subhead ops-figures ${problem ? 'ops-problem' : 'secondary'}`}>{figures}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** For Graphinity's owner: how the whole thing is doing. Totals only; nothing here names anyone. */
export function OwnerPage() {
  const { data, error } = useLoad<Summary>('/owner/dashboard/summary', true);
  if (error) return <Note text={error.message} />;
  if (!data) return <Note text="Loading…" />;
  const { brokenAt, entries } = data.audit;
  return (
    <main className="page review">
      <h1 className="text-title1">Owner</h1>
      <Section
        title="Activity"
        empty=""
        rows={[
          period('Today', data.totals.day),
          period('Last 7 days', data.totals.week),
          period('Last 28 days', data.totals.month),
        ]}
      />
      <Section
        title="Products people ask about"
        empty="Shown from 25 people."
        rows={data.commerce.map(p => [
          p.label,
          `About ${n(p.count)} this week${p.forecast === null ? '' : ` · ${n(p.forecast)} in 30 days`}`,
        ])}
      />
      <Section
        title="Experiments"
        empty="None running."
        rows={data.experiments.map(e =>
          e.status === 'halted_srm'
            ? [e.name, 'Stopped: uneven groups', true]
            : [e.name, `${e.status} · p ≤ ${e.p.toFixed(3)}`],
        )}
      />
      <Section
        title="Models"
        empty="None trained yet."
        rows={data.models.map(m => [
          m.name,
          `Version ${String(m.version)} · ${m.stage.toLowerCase()} · ${m.algorithm}`,
        ])}
      />
      <Section
        title="Audit log"
        empty=""
        rows={[
          brokenAt === null
            ? ['Unchanged', `${n(entries)} entries`]
            : [`Entry ${String(brokenAt)} was changed`, 'Untrusted from here', true],
        ]}
      />
    </main>
  );
}
