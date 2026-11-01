import { useState } from 'react';
import { ApiError } from '../lib/api.ts';
import { api } from '../session.tsx';
import { useLoad } from '../use-load.ts';
import { Button } from './Button.tsx';
import { TextArea } from './Form.tsx';

interface Grievance {
  id: string;
  reference: string;
  kind: string;
  body: string;
  acknowledgeBy: string;
  resolveBy: string;
  acknowledgedAt: string | null;
}
interface Appeal {
  id: string;
  facts: string;
  why: string;
}

// The API's page size. The soonest deadlines come first, so anything past the first page is still on a clock.
const PAGE_SIZE = 100;

/** Complaints on their legal clocks, and appeals, for moderators (ADR 0027). */
export function LegalQueue() {
  const [page, setPage] = useState(0);
  const complaints = useLoad<{ rows: Grievance[]; open: number }>(`/ops/grievances?page=${String(page)}`, true);
  const pages = Math.ceil((complaints.data?.open ?? 0) / PAGE_SIZE);
  // Resolving can empty the last page: step back, or it would read as if nothing were waiting.
  if (complaints.data && pages > 0 && page >= pages) setPage(pages - 1);
  const appeals = useLoad<{ appeals: Appeal[] }>('/ops/appeals', true);
  const [done, setDone] = useState<Record<string, string>>({});
  const [outcome, setOutcome] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  async function act(id: string, work: () => Promise<unknown>, said: string) {
    setError(null);
    try {
      await work();
      setDone(d => ({ ...d, [id]: said }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That didn’t save. Try again.');
    }
  }
  const late = (at: string) => new Date(at) < new Date();

  return (
    <section className="review-section" aria-labelledby="legal-heading">
      <h2 id="legal-heading" className="text-title3">
        Complaints and appeals
      </h2>
      {complaints.data?.open === 0 && appeals.data?.appeals.length === 0 && (
        <p className="text-body secondary">None waiting.</p>
      )}
      {error && (
        <p className="form-note tone-bad" role="alert">
          {error}
        </p>
      )}
      <ul className="review-list">
        {complaints.data?.rows.map(g => (
          <li key={g.id} className="review-item">
            <p className="text-footnote secondary">
              {g.reference} · {g.kind.replaceAll('_', ' ')} ·{' '}
              {g.acknowledgedAt ? 'Acknowledged' : `Acknowledge by ${new Date(g.acknowledgeBy).toLocaleString()}`} ·{' '}
              <span className={late(g.resolveBy) ? 'tone-bad' : ''}>
                Resolve by {new Date(g.resolveBy).toLocaleString()}
              </span>
            </p>
            <p className="text-body post-body">{g.body}</p>
            {done[g.id] ? (
              <p className="text-subhead" role="status">
                {done[g.id]}
              </p>
            ) : (
              <>
                {!g.acknowledgedAt && (
                  <Button
                    variant="secondary"
                    onClick={() =>
                      void act(
                        g.id,
                        () =>
                          api(`/ops/grievances/${g.id}`, {
                            method: 'PATCH',
                            signedIn: true,
                            body: { action: 'acknowledge' },
                          }),
                        'Acknowledged.',
                      )
                    }
                  >
                    Acknowledge
                  </Button>
                )}
                <TextArea
                  label="What was decided?"
                  rows={2}
                  value={outcome[g.id] ?? ''}
                  onChange={value => {
                    setOutcome(o => ({ ...o, [g.id]: value }));
                  }}
                />
                <Button
                  disabled={(outcome[g.id] ?? '').trim().length < 5}
                  onClick={() =>
                    void act(
                      g.id,
                      () =>
                        api(`/ops/grievances/${g.id}`, {
                          method: 'PATCH',
                          signedIn: true,
                          body: { action: 'resolve', outcome: outcome[g.id] },
                        }),
                      'Resolved.',
                    )
                  }
                >
                  Resolve
                </Button>
              </>
            )}
          </li>
        ))}
        {pages > 1 && (
          <li className="review-actions">
            <p className="text-footnote secondary" role="status">
              Complaints page {page + 1} of {pages}
            </p>
            <Button
              variant="secondary"
              disabled={page === 0}
              onClick={() => {
                setPage(p => p - 1);
              }}
            >
              Sooner deadlines
            </Button>
            <Button
              variant="secondary"
              disabled={page + 1 >= pages}
              onClick={() => {
                setPage(p => p + 1);
              }}
            >
              Later deadlines
            </Button>
          </li>
        )}
        {appeals.data?.appeals.map(a => (
          <li key={a.id} className="review-item">
            <p className="text-footnote secondary">Appeal: {a.facts}</p>
            <p className="text-body post-body">{a.why}</p>
            {done[a.id] ? (
              <p className="text-subhead" role="status">
                {done[a.id]}
              </p>
            ) : (
              <div className="review-actions">
                {(['uphold', 'overturn'] as const).map(decision => (
                  <Button
                    key={decision}
                    variant="secondary"
                    onClick={() =>
                      void act(
                        a.id,
                        () => api(`/ops/appeals/${a.id}`, { method: 'POST', signedIn: true, body: { decision } }),
                        decision === 'uphold' ? 'The removal stands.' : 'Overturned: the post is back.',
                      )
                    }
                  >
                    {decision === 'uphold' ? 'Keep it removed' : 'Put it back'}
                  </Button>
                ))}
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
