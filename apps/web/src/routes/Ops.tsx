import { Button } from '../components/Button.tsx';
import { LegalQueue } from '../components/LegalQueue.tsx';
import { ApiError } from '../lib/api.ts';
import { api } from '../session.tsx';
import { useState, type CSSProperties } from 'react';
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
  rollouts: Array<{ name: string; ring: number | null; trippedAt: string | null }>;
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

      <LegalQueue />

      {status.rollouts.length > 0 && (
        <section className="review-section" aria-labelledby="rollouts-heading">
          <h2 id="rollouts-heading" className="text-title3">
            Rollouts
          </h2>
          <ul className="standing-list">
            {status.rollouts.map(r => (
              <li key={r.name} className="standing-row ops-row">
                <span className="text-body">{r.name.replaceAll('_', ' ')}</span>
                <span className={`text-subhead ops-figures ${r.trippedAt ? 'ops-problem' : 'secondary'}`}>
                  {r.trippedAt ? 'Turned off: requests went bad' : `${String([1, 5, 25, 100][r.ring ?? 3])}% of people`}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

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
  evaluations: Array<{ name: string; metrics: Record<string, unknown>; at: string }>;
  experiments: Array<{ name: string; status: string; p: number }>;
  commerce: Array<{ label: string; count: number; forecast: number | null }>;
  together: Array<{ from: string; to: string; people: number; lift: number }>;
  answering: {
    questions: number;
    resolvedRate: number | null;
    answeredRate: number | null;
    medianMinutes: number | null;
    p95Minutes: number | null;
  };
  retention: Array<{ week: string; size: number; weeks: Array<number | null> }>;
  economics: Array<{
    currency: string;
    lifetimeWeeks: number;
    lifetimeValueMicros: number | null;
    costPerJoinMicros: number | null;
  }>;
  failedPushes: number;
  health: {
    objectives: Array<{ name: string; budgetRemaining: number; burn: { hour: number; day: number } }>;
  };
  audit: { entries: number; brokenAt: number | null };
}

type Row = [name: string, figures: string, problem?: boolean];

const n = (x: number) => count.format(Math.round(x));
const share = (x: number | null) => (x === null ? '—' : `${String(Math.round(x * 100))}%`);
const minutes = (x: number | null) =>
  x === null ? '—' : x < 90 ? `${String(Math.round(x))} minutes` : `${(x / 60).toFixed(1)} hours`;
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

const money = (micros: number | null, currency: string) =>
  micros === null
    ? 'no figure yet'
    : new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(micros / 1_000_000);

/** What the owner spent bringing people in. Only the owner knows this, so only the owner can say it. */
function SpendForm({ onSaved }: { onSaved: () => void }) {
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const value = Number(amount);
  const usable =
    amount.trim() !== '' && Number.isFinite(value) && value >= 0 && /^20\d{2}-(0[1-9]|1[0-2])$/.test(month);

  async function save() {
    setNote(null);
    try {
      await api('/owner/acquisition-spend', {
        method: 'PUT',
        signedIn: true,
        body: { month, currency: 'INR', amountMicros: Math.round(value * 1_000_000) },
      });
      setAmount('');
      setNote('Saved. Saving the same month again replaces it.');
      onSaved();
    } catch (err) {
      setNote(err instanceof ApiError ? err.message : 'That didn’t save. Try again.');
    }
  }

  return (
    <form
      className="review-section"
      onSubmit={e => {
        e.preventDefault();
        void save();
      }}
    >
      <label htmlFor="spend-month" className="text-subhead">
        Month (year-month)
      </label>
      <input
        id="spend-month"
        className="input"
        value={month}
        onChange={e => {
          setMonth(e.target.value);
        }}
      />
      <label htmlFor="spend-amount" className="text-subhead">
        Spent bringing people in, in rupees
      </label>
      <input
        id="spend-amount"
        className="input"
        inputMode="decimal"
        value={amount}
        onChange={e => {
          setAmount(e.target.value);
        }}
      />
      <Button type="submit" disabled={!usable}>
        Save spend
      </Button>
      {note && (
        <p className="text-footnote secondary" role="status">
          {note}
        </p>
      )}
    </form>
  );
}

/** Each joining week, then a cell per week since, deeper where more people came back. Cells wrap, so 13 never overflow a phone. */
function RetentionHeatmap({ cohorts }: { cohorts: Summary['retention'] }) {
  return (
    <section className="review-section">
      <h2 className="text-title3">Who comes back</h2>
      {cohorts.length === 0 ? (
        <p className="text-body secondary">Shown for weeks when at least 25 people joined.</p>
      ) : (
        <ul className="standing-list">
          {cohorts.map(c => (
            <li key={c.week}>
              <p className="text-subhead">
                Joined {c.week} ({n(c.size)})
              </p>
              <ul className="standing-list heat text-footnote">
                {c.weeks.map((w, i) => (
                  <li
                    key={i}
                    style={w === null ? undefined : ({ '--heat': `${String(Math.round(w * 40))}%` } as CSSProperties)}
                  >
                    Week {i}: {share(w)}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Numbers as a line of text; lists, like a curve over ranks, say how long they are. */
function describeEvaluation(metrics: Record<string, unknown>): string {
  return Object.entries(metrics)
    .map(
      ([k, v]) =>
        `${k} ${typeof v === 'number' ? String(Number(v.toPrecision(3))) : Array.isArray(v) ? `(${String(v.length)} values)` : ''}`,
    )
    .join(' · ');
}

/** For Graphinity's owner: how the whole thing is doing. Totals only; nothing here names anyone. */
export function OwnerPage() {
  const { data, error, retry } = useLoad<Summary>('/owner/dashboard/summary', true);
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
        title="Getting answers"
        empty="Shown once questions are 4 days old."
        rows={
          data.answering.questions === 0
            ? []
            : [
                ['Resolved within 4 days', share(data.answering.resolvedRate)],
                ['Got an answer', share(data.answering.answeredRate)],
                [
                  'Time to first answer',
                  `${minutes(data.answering.medianMinutes)} typical · ${minutes(data.answering.p95Minutes)} at the slow end`,
                ],
              ]
        }
      />
      <RetentionHeatmap cohorts={data.retention} />
      <Section
        title="What a person is worth"
        empty="Shown once there’s ad income, or you’ve recorded what you spent bringing people in."
        rows={data.economics.map(e => [
          e.currency,
          `Roughly worth ${money(e.lifetimeValueMicros, e.currency)} over about ${e.lifetimeWeeks.toFixed(1)} weeks · costs ${money(e.costPerJoinMicros, e.currency)} to bring in`,
        ])}
      />
      <SpendForm onSaved={retry} />
      <Section
        title="Error budget"
        empty=""
        rows={data.health.objectives.map(o => [
          o.name === 'availability' ? 'Requests succeeding' : 'Requests fast enough',
          `${share(o.budgetRemaining)} of the month’s allowance left · using it ${o.burn.hour.toFixed(1)}× too fast this hour`,
          o.budgetRemaining < 0.1,
        ])}
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
        title="Asked about together"
        empty="Shown from 25 people."
        rows={data.together.map(t => [
          `${t.from} and ${t.to}`,
          `${n(t.people)} people · ${t.lift.toFixed(1)}× more than chance`,
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
        title="Measurements"
        empty="Not enough data yet. Each needs a few hundred real events first."
        rows={data.evaluations.map(e => [e.name, describeEvaluation(e.metrics)])}
      />
      {data.failedPushes > 0 && (
        <Section title="Partner lists" empty="" rows={[['Not delivered in 7 days', n(data.failedPushes), true]]} />
      )}
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
