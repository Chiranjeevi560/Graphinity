import { useEffect, useState } from 'react';
import { Button } from './Button.tsx';
import { onLive } from '../lib/live.ts';
import { questionPath, timeAgo, type QuestionSummary } from '../lib/questions.ts';
import { Link } from '../lib/router.ts';
import { api } from '../session.tsx';

type InboxQuestion = QuestionSummary & { routedAt: string; seen: boolean; passUndoUntil: string | null };

/** Questions put to you because of what you know. Hidden until there are any. */
export function Inbox() {
  const [inbox, setInbox] = useState<{ questions: InboxQuestion[]; unseen: number } | null>(null);
  const [now, setNow] = useState(Date.now);
  const [actingOn, setActingOn] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const load = () => {
      api<{ questions: InboxQuestion[]; unseen: number }>('/me/inbox', { signedIn: true })
        .then(res => {
          if (live) setInbox(res);
        })
        // The inbox is extra on this screen: if it can't load, the rest still works.
        .catch(() => {});
    };
    load();
    const stop = onLive(e => {
      if (e.type === 'routed') load();
    });
    return () => {
      live = false;
      stop();
    };
  }, []);

  useEffect(() => {
    const deadlines =
      inbox?.questions
        .map(q => (q.passUndoUntil ? Date.parse(q.passUndoUntil) : 0))
        .filter(deadline => deadline > now) ?? [];
    if (!deadlines.length) return;
    const timer = setTimeout(
      () => {
        setNow(Date.now());
      },
      Math.max(0, Math.min(...deadlines) - now + 25),
    );
    return () => {
      clearTimeout(timer);
    };
  }, [inbox, now]);

  async function pass(questionId: string) {
    setActingOn(questionId);
    setError(null);
    try {
      const result = await api<{ undoUntil: string }>(`/me/inbox/${encodeURIComponent(questionId)}/pass`, {
        method: 'POST',
        signedIn: true,
      });
      setInbox(current =>
        current
          ? {
              ...current,
              questions: current.questions.map(q =>
                q.id === questionId ? { ...q, passUndoUntil: result.undoUntil } : q,
              ),
            }
          : current,
      );
    } catch {
      setError('That question could not be passed. Refresh your inbox and try again.');
    } finally {
      setActingOn(null);
    }
  }

  async function undoPass(questionId: string) {
    setActingOn(questionId);
    setError(null);
    try {
      await api(`/me/inbox/${encodeURIComponent(questionId)}/undo-pass`, { method: 'POST', signedIn: true });
      const result = await api<{ questions: InboxQuestion[]; unseen: number }>('/me/inbox', { signedIn: true });
      setInbox(result);
    } catch {
      setError('The undo window may have ended. Refresh your inbox to see what is still available.');
    } finally {
      setActingOn(null);
    }
  }

  const visible = inbox?.questions.filter(q => q.passUndoUntil === null) ?? [];
  const undoable = inbox?.questions.filter(q => q.passUndoUntil && Date.parse(q.passUndoUntil) > now) ?? [];
  if (!inbox || (visible.length === 0 && undoable.length === 0 && !error)) return null;
  return (
    <section className="home-questions" aria-labelledby="inbox-heading">
      <h2 id="inbox-heading" className="text-title3">
        Asked of you{inbox.unseen > 0 && <span className="inbox-count"> · {inbox.unseen} new</span>}
      </h2>
      <ul className="question-list">
        {visible.map(q => (
          <li key={q.id} className="question-row">
            <Link to={questionPath(q)} className="question-link">
              <span className="text-headline question-title">
                {!q.seen && <span className="unseen-dot" aria-label="New" role="img" />}
                {q.title}
              </span>
              <span className="text-footnote secondary question-meta">
                <span>{q.field.name}</span>
                {q.country && <span>{q.country.name}</span>}
                <span>{q.answerCount === 1 ? '1 answer' : `${String(q.answerCount)} answers`}</span>
                <span>{timeAgo(q.routedAt, now)}</span>
              </span>
            </Link>
            <Button
              variant="secondary"
              className="inbox-pass"
              disabled={actingOn !== null}
              onClick={() => void pass(q.id)}
            >
              {actingOn === q.id ? 'Passing…' : 'Pass'}
            </Button>
          </li>
        ))}
      </ul>
      {undoable.map(q => (
        <p className="inbox-undo text-subhead" role="status" key={q.id}>
          Passed on “{q.title}”. You can undo for 7 seconds.
          <Button variant="secondary" disabled={actingOn !== null} onClick={() => void undoPass(q.id)}>
            {actingOn === q.id ? 'Undoing…' : 'Undo'}
          </Button>
        </p>
      ))}
      {error && (
        <p className="text-subhead tone-bad" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
