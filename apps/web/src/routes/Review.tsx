import { useEffect, useState } from 'react';
import { ApiError } from '../lib/api.ts';
import { Link } from '../lib/router.ts';
import { api } from '../session.tsx';

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
interface Review { items: Item[]; sharedNetworks: Array<{ giver: string; recipient: string; points: number }> }

const reasonNames: Record<string, string> = {
  spam: 'Spam', abuse: 'Abusive', private_info: 'Private information', misleading: 'Misleading', other: 'Other',
};

/** For moderators: reported posts and points exchanged from shared networks. */
export default function ReviewPage() {
  const [review, setReview] = useState<Review | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<Record<string, string>>({});

  useEffect(() => {
    let live = true;
    api<Review>('/review', { signedIn: true })
      .then(r => { if (live) setReview(r); })
      .catch((err: unknown) => { if (live) setError(err instanceof ApiError ? err.message : 'The review couldn’t load. Try again in a minute.'); });
    return () => { live = false; };
  }, []);

  async function act(key: string, label: string, work: () => Promise<unknown>) {
    setBusy(key);
    try {
      await work();
      setDone(d => ({ ...d, [key]: label }));
    } catch (err) {
      setDone(d => ({ ...d, [key]: err instanceof ApiError ? err.message : 'That didn’t save. Try again.' }));
    } finally {
      setBusy(null);
    }
  }

  if (error) return <main className="page stack-message"><h1 className="text-title2">{error}</h1></main>;
  if (!review) return <main className="page stack-message"><p className="text-body status" role="status">Loading…</p></main>;

  return (
    <main className="page review">
      <h1 className="text-title1">Review</h1>
      <section className="review-section" aria-labelledby="reported-heading">
        <h2 id="reported-heading" className="text-title3">Reported</h2>
        {review.items.length === 0 && <p className="text-body secondary">Nothing to review. Reports appear here as people send them.</p>}
        <ul className="review-list">
          {review.items.map(item => {
            const key = `${item.kind}:${item.id}`;
            return (
              <li key={key} className="review-item">
                <p className="text-footnote secondary">
                  {item.kind === 'question' ? 'Question' : 'Answer'} by <Link to={`/u/${encodeURIComponent(item.author.handle)}`}>@{item.author.handle}</Link>
                  {' · '}{item.reports === 1 ? '1 report' : `${String(item.reports)} reports`}
                  {' · '}{item.reasons.map(r => reasonNames[r] ?? r).join(', ')}
                  {item.hidden && ' · Hidden'}
                </p>
                <p className="text-body post-body review-text">{item.text}</p>
                {item.notes.length > 0 && (
                  <ul className="review-notes text-subhead secondary">
                    {item.notes.map((n, i) => <li key={i}>“{n}”</li>)}
                  </ul>
                )}
                <p className="text-footnote"><Link to={`/q/${item.questionId}`}>Open the question</Link></p>
                {done[key] ? <p className="text-subhead" role="status">{done[key]}</p> : (
                  <div className="review-actions">
                    <button type="button" className="btn btn-plain" disabled={busy !== null}
                      onClick={() => { void act(key, 'Kept. It’s visible again.', () => api('/review/decision', { method: 'POST', signedIn: true, body: { kind: item.kind, id: item.id, decision: 'keep' } })); }}>
                      Keep
                    </button>
                    <button type="button" className="btn btn-plain danger" disabled={busy !== null}
                      onClick={() => { void act(key, 'Removed.', () => api('/review/decision', { method: 'POST', signedIn: true, body: { kind: item.kind, id: item.id, decision: 'remove' } })); }}>
                      Remove
                    </button>
                    <button type="button" className="btn btn-plain danger" disabled={busy !== null}
                      onClick={() => { void act(key, `@${item.author.handle} is blocked from posting.`, () => api('/review/block', { method: 'POST', signedIn: true, body: { handle: item.author.handle, reason: item.reasons.join(', ') } })); }}>
                      Block @{item.author.handle}
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      <section className="review-section" aria-labelledby="networks-heading">
        <h2 id="networks-heading" className="text-title3">Points from shared networks</h2>
        <p className="text-subhead secondary">People who gave each other points in the last 30 days while on the same network. Often innocent (a family, an office, a mobile carrier); worth a look when the points are high.</p>
        {review.sharedNetworks.length === 0 ? <p className="text-body secondary">None.</p> : (
          <ul className="standing-list">
            {review.sharedNetworks.map(p => (
              <li key={`${p.giver}>${p.recipient}`} className="standing-row">
                <span className="text-body">@{p.giver} → @{p.recipient}</span>
                <span className="text-subhead secondary">{p.points} points</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
