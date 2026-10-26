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

/** A job's name as a person would say it. */
const jobWords: Record<string, string> = {
  deletions: 'Finishing account deletions',
  'signal-expiry': 'Forgetting expired activity',
  'route-factor-expiry': 'Forgetting old routing records',
  'search-expiry': 'Forgetting old searches',
  'graph-projection': 'Updating personal graphs',
  routing: 'Sending questions to people',
  'embedding-backfill': 'Understanding new questions',
  training: 'Training Graphinity’s own models',
  'search-judge': 'Comparing search rankings',
  'drift-monitor': 'Checking models still fit',
  'collusion-review': 'Looking for groups picking each other',
  alerts: 'Sending alerts to moderators',
};

/** For moderators: whether Graphinity is working as it should, in plain words. */
export default function OpsPage() {
  const { data: status, error, retry } = useLoad<Status>('/ops/status', true);
  // Times are "5 minutes ago" as of loading; reloading the page brings them up to date.
  const [now] = useState(Date.now);
  if (error) return <LoadFailed error={error} onRetry={retry} />;
  if (!status)
    return (
      <main className="page stack-message">
        <p className="text-body status" role="status">
          Loading…
        </p>
      </main>
    );
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
                  {jobWords[j.job] ?? j.job}:{' '}
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

      <section className="review-section" aria-labelledby="objectives-heading">
        <h2 id="objectives-heading" className="text-title3">
          The last 30 days
        </h2>
        <ul className="standing-list">
          {status.objectives.map(o => (
            <li key={o.name} className="standing-row ops-row">
              <span className="text-body">{objectiveWords[o.name]}</span>
              <span className="text-subhead secondary ops-figures">
                {o.good === null ? 'No requests yet' : `${percent(o.good, 2)}, against a goal of ${percent(o.target)}`}
                {o.good !== null && (
                  <>
                    {' · '}
                    <span className={o.budgetRemaining < 0 ? 'ops-problem' : undefined}>
                      {o.budgetRemaining < 0
                        ? 'allowance used up'
                        : `${percent(Math.min(1, o.budgetRemaining), 0)} of the allowance left`}
                    </span>
                  </>
                )}
              </span>
            </li>
          ))}
        </ul>
        <p className="text-footnote secondary">
          The allowance is how many requests may fail, or be slow, in 30 days while still meeting the objective.
        </p>
      </section>

      <section className="review-section" aria-labelledby="jobs-heading">
        <h2 id="jobs-heading" className="text-title3">
          Background work
        </h2>
        {status.jobs.length === 0 ? (
          <p className="text-body secondary">Nothing has run yet.</p>
        ) : (
          <ul className="standing-list">
            {status.jobs.map(j => (
              <li key={j.job} className="standing-row ops-row">
                <span className="text-body">{jobWords[j.job] ?? j.job}</span>
                <span className={`text-subhead ops-figures ${j.healthy ? 'secondary' : 'ops-problem'}`}>
                  {j.lastFailureAt && (!j.lastSuccessAt || j.lastFailureAt > j.lastSuccessAt)
                    ? `Failed ${timeAgo(j.lastFailureAt, now)}`
                    : j.lastSuccessAt
                      ? `Worked ${timeAgo(j.lastSuccessAt, now)}`
                      : 'Not worked yet'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="review-section" aria-labelledby="routes-heading">
        <h2 id="routes-heading" className="text-title3">
          Slowest requests today
        </h2>
        {status.routes.length === 0 ? (
          <p className="text-body secondary">No requests today.</p>
        ) : (
          <ul className="standing-list">
            {status.routes.map(r => (
              <li key={`${r.method} ${r.route}`} className="standing-row ops-row">
                <span className="text-subhead ops-route">
                  {r.method} {r.route}
                </span>
                <span className="text-subhead secondary ops-figures">
                  {count.format(r.requests)} {r.requests === 1 ? 'request' : 'requests'}
                  {r.p95 !== null && ` · 95% within ${count.format(Math.round(r.p95))} ms`}
                  {r.errors > 0 && <span className="ops-problem">{` · ${count.format(r.errors)} failed`}</span>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
