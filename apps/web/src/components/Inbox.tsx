import { useEffect, useState } from 'react';
import { onLive } from '../lib/live.ts';
import { questionPath, timeAgo, type QuestionSummary } from '../lib/questions.ts';
import { Link } from '../lib/router.ts';
import { api } from '../session.tsx';

type InboxQuestion = QuestionSummary & { routedAt: string; seen: boolean };

/** Questions put to you because of what you know. Hidden until there are any. */
export function Inbox() {
  const [inbox, setInbox] = useState<{ questions: InboxQuestion[]; unseen: number } | null>(null);
  const [now] = useState(Date.now);

  useEffect(() => {
    let live = true;
    const load = () => {
      api<{ questions: InboxQuestion[]; unseen: number }>('/me/inbox', { signedIn: true })
        .then(res => { if (live) setInbox(res); })
        // The inbox is extra on this screen: if it can't load, the rest still works.
        .catch(() => {});
    };
    load();
    const stop = onLive(e => { if (e.type === 'routed') load(); });
    return () => { live = false; stop(); };
  }, []);

  if (!inbox || inbox.questions.length === 0) return null;
  return (
    <section className="home-questions" aria-labelledby="inbox-heading">
      <h2 id="inbox-heading" className="text-title3">
        Asked of you{inbox.unseen > 0 && <span className="inbox-count"> · {inbox.unseen} new</span>}
      </h2>
      <ul className="question-list">
        {inbox.questions.map(q => (
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
          </li>
        ))}
      </ul>
    </section>
  );
}
