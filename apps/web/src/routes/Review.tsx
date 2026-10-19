import { useState } from 'react';
import { LoadFailed } from '../components/Message.tsx';
import { ApiError } from '../lib/api.ts';
import { Link } from '../lib/router.ts';
import { api } from '../session.tsx';
import { useLoad } from '../use-load.ts';

interface Item {
  kind: 'question' | 'answer';
  id: string;
  questionId: string;
  text: string;
  author: { handle: string };
  reports: number;
  reasons: string[];
  notes: string[];
  hidden: boolean;
  lastReportAt: string;
}
interface Review {
  items: Item[];
  sharedNetworks: Array<{ giver: string; recipient: string; points: number }>;
}

const reasonNames: Record<string, string> = {
  spam: 'Spam',
  abuse: 'Abusive',
  private_info: 'Private information',
  misleading: 'Misleading',
  other: 'Other',
};

/** For moderators: reported posts and points exchanged from shared networks. */
export default function ReviewPage() {
  const { data: review, error, retry } = useLoad<Review>('/review', true);
  const [busy, setBusy] = useState<string | null>(null);
  // Kept apart: a decision on the post and a block on its author are separate
  // steps, and a failure must leave the buttons there to try again.
  const [decided, setDecided] = useState<Record<string, string>>({});
  const [blocked, setBlocked] = useState<Record<string, true>>({});
  const [failed, setFailed] = useState<Record<string, string>>({});

  async function act(key: string, work: () => Promise<unknown>, saved: () => void) {
    setBusy(key);
    setFailed(({ [key]: _, ...rest }) => rest);
    try {
      await work();
      saved();
    } catch (err) {
      setFailed(f => ({ ...f, [key]: err instanceof ApiError ? err.message : 'That didn’t save. Try again.' }));
    } finally {
      setBusy(null);
    }
  }

  const decide = (item: Item, key: string, decision: 'keep' | 'remove') =>
    act(
      key,
      () =>
        api('/review/decision', { method: 'POST', signedIn: true, body: { kind: item.kind, id: item.id, decision } }),
      () => {
        setDecided(d => ({ ...d, [key]: decision === 'keep' ? 'Kept. It’s visible again.' : 'Removed.' }));
      },
    );
  const block = (item: Item, key: string) =>
    act(
      key,
      () =>
        api('/review/block', {
          method: 'POST',
          signedIn: true,
          body: { handle: item.author.handle, reason: item.reasons.join(', ') },
        }),
      () => {
        setBlocked(b => ({ ...b, [item.author.handle]: true }));
      },
    );

  if (error) return <LoadFailed error={error} onRetry={retry} />;
  if (!review)
    return (
      <main className="page stack-message">
        <p className="text-body status" role="status">
          Loading…
        </p>
      </main>
    );

  return (
    <main className="page review">
      <h1 className="text-title1">Review</h1>
      <section className="review-section" aria-labelledby="reported-heading">
        <h2 id="reported-heading" className="text-title3">
          Reported
        </h2>
        {review.items.length === 0 && (
          <p className="text-body secondary">Nothing to review. Reports appear here as people send them.</p>
        )}
        <ul className="review-list">
          {review.items.map(item => {
            const key = `${item.kind}:${item.id}`;
            return (
              <li key={key} className="review-item">
                <p className="text-footnote secondary">
                  {item.kind === 'question' ? 'Question' : 'Answer'} by{' '}
                  <Link to={`/u/${encodeURIComponent(item.author.handle)}`}>@{item.author.handle}</Link>
                  {' · '}
                  {item.reports === 1 ? '1 report' : `${String(item.reports)} reports`}
                  {' · '}
                  {item.reasons.map(r => reasonNames[r] ?? r).join(', ')}
                  {item.hidden && ' · Hidden'}
                </p>
                <p className="text-body post-body review-text">{item.text}</p>
                {item.notes.length > 0 && (
                  <ul className="review-notes text-subhead secondary">
                    {item.notes.map((n, i) => (
                      <li key={i}>“{n}”</li>
                    ))}
                  </ul>
                )}
                <p className="text-footnote">
                  <Link to={`/q/${item.questionId}`}>Open the question</Link>
                </p>
                {decided[key] && (
                  <p className="text-subhead" role="status">
                    {decided[key]}
                  </p>
                )}
                {blocked[item.author.handle] && (
                  <p className="text-subhead" role="status">
                    @{item.author.handle} is blocked from posting.
                  </p>
                )}
                {failed[key] && (
                  <p className="form-note tone-bad" role="alert">
                    {failed[key]}
                  </p>
                )}
                {(!decided[key] || !blocked[item.author.handle]) && (
                  <div className="review-actions">
                    {!decided[key] && (
                      <>
                        <button
                          type="button"
                          className="btn btn-plain"
                          disabled={busy !== null}
                          onClick={() => {
                            void decide(item, key, 'keep');
                          }}
                        >
                          Keep
                        </button>
                        <button
                          type="button"
                          className="btn btn-plain danger"
                          disabled={busy !== null}
                          onClick={() => {
                            void decide(item, key, 'remove');
                          }}
                        >
                          Remove
                        </button>
                      </>
                    )}
                    {!blocked[item.author.handle] && (
                      <button
                        type="button"
                        className="btn btn-plain danger"
                        disabled={busy !== null}
                        onClick={() => {
                          void block(item, key);
                        }}
                      >
                        Block @{item.author.handle}
                      </button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      <section className="review-section" aria-labelledby="networks-heading">
        <h2 id="networks-heading" className="text-title3">
          Points from shared networks
        </h2>
        <p className="text-subhead secondary">
          People who gave each other points in the last 30 days while on the same network. Often innocent (a family, an
          office, a mobile carrier); worth a look when the points are high.
        </p>
        {review.sharedNetworks.length === 0 ? (
          <p className="text-body secondary">None.</p>
        ) : (
          <ul className="standing-list">
            {review.sharedNetworks.map(p => (
              <li key={`${p.giver}>${p.recipient}`} className="standing-row">
                <span className="text-body">
                  @{p.giver} → @{p.recipient}
                </span>
                <span className="text-subhead secondary">{p.points} points</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
