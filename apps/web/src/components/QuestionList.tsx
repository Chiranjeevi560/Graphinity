import { useEffect, useState } from 'react';
import { ApiError } from '../lib/api.ts';
import { questionPath, timeAgo, type QuestionSummary } from '../lib/questions.ts';
import { Link } from '../lib/router.ts';
import { api } from '../session.tsx';
import { Button } from './Button.tsx';

/** Newest questions, a page at a time. Reading needs no account. */
export function QuestionList() {
  const [questions, setQuestions] = useState<QuestionSummary[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [now] = useState(Date.now);

  async function loadMore(before: string) {
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await api<{ questions: QuestionSummary[]; next: string | null }>(`/questions?before=${before}`);
      setQuestions(prev => [...(prev ?? []), ...page.questions]);
      setNext(page.next);
    } catch (err) {
      setMoreError(err instanceof ApiError ? err.message : 'More questions couldn’t load. Try again.');
    } finally {
      setLoadingMore(false);
    }
  }

  useEffect(() => {
    let live = true;
    api<{ questions: QuestionSummary[]; next: string | null }>('/questions')
      .then(page => { if (live) { setQuestions(page.questions); setNext(page.next); } })
      .catch((err: unknown) => { if (live) setError(err instanceof ApiError ? err.message : 'Questions couldn’t load. Try again in a minute.'); });
    return () => { live = false; };
  }, []);

  if (error) return <p className="text-body secondary" role="alert">{error}</p>;
  if (!questions) return <p className="text-body secondary status" role="status">Loading questions…</p>;
  if (questions.length === 0) return <p className="text-body secondary">No questions yet. Be the first to ask.</p>;

  return (
    <>
      <ul className="question-list">
        {questions.map(q => (
          <li key={q.id} className="question-row">
            <Link to={questionPath(q)} className="question-link">
              <span className="text-headline question-title">{q.title}</span>
              <span className="text-footnote secondary question-meta">
                <span>{q.field.name}</span>
                {q.country && <span>{q.country.name}</span>}
                <span>{q.answerCount === 1 ? '1 answer' : `${String(q.answerCount)} answers`}</span>
                <span>{timeAgo(q.createdAt, now)}</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
      {moreError && <p className="form-note tone-bad" role="alert">{moreError}</p>}
      {next && (
        <Button variant="secondary" className="btn-block" disabled={loadingMore} onClick={() => { void loadMore(next); }}>
          {loadingMore ? 'Loading…' : 'Show more'}
        </Button>
      )}
    </>
  );
}
