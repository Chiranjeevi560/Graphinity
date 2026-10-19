import { useState } from 'react';
import { ApiError } from '../lib/api.ts';
import { questionPath, timeAgo, type QuestionSummary } from '../lib/questions.ts';
import { Link } from '../lib/router.ts';
import { api } from '../session.tsx';
import { useLoad } from '../use-load.ts';
import { Button } from './Button.tsx';
import { LoadFailed } from './Message.tsx';

interface Page {
  questions: QuestionSummary[];
  next: string | null;
}

/** Newest questions, a page at a time. Reading needs no account. */
export function QuestionList() {
  const { data, error, retry, setData } = useLoad<Page>('/questions');
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [now] = useState(Date.now);

  async function loadMore(before: string) {
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await api<Page>(`/questions?before=${before}`);
      setData({ questions: [...(data?.questions ?? []), ...page.questions], next: page.next });
    } catch (err) {
      setMoreError(err instanceof ApiError ? err.message : 'More questions couldn’t load. Try again.');
    } finally {
      setLoadingMore(false);
    }
  }

  if (error) return <LoadFailed error={error} onRetry={retry} inline />;
  if (!data)
    return (
      <p className="text-body secondary status" role="status">
        Loading questions…
      </p>
    );
  const { questions, next } = data;
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
      {moreError && (
        <p className="form-note tone-bad" role="alert">
          {moreError}
        </p>
      )}
      {next && (
        <Button
          variant="secondary"
          className="btn-block"
          disabled={loadingMore}
          onClick={() => {
            void loadMore(next);
          }}
        >
          {loadingMore ? 'Loading…' : 'Show more'}
        </Button>
      )}
    </>
  );
}
