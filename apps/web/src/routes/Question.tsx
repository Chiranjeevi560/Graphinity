import { useEffect, useState, type SubmitEvent } from 'react';
import { Button, LinkButton } from '../components/Button.tsx';
import { TextArea } from '../components/Form.tsx';
import { BackButton } from '../components/BackButton.tsx';
import { GoogleButton } from '../components/GoogleButton.tsx';
import { MessageScreen, splitMessage } from '../components/Message.tsx';
import { ReportButton } from '../components/ReportButton.tsx';
import { ApiError } from '../lib/api.ts';
import { onLive } from '../lib/live.ts';
import { applyMeta } from '../lib/meta.ts';
import { ANSWER, charCount, questionPath, timeAgo, type Answer, type QuestionSummary, type Selection } from '../lib/questions.ts';
import { AnswerActions, AnswerLabels } from '../components/AnswerActions.tsx';
import { Link } from '../lib/router.ts';
import { api, useSession } from '../session.tsx';

interface Page { question: QuestionSummary & { body: string; hidden: boolean }; answers: Array<Answer & { hidden: boolean }>; selection: Selection | null }

/**
 * The address carries the title's current wording: fix it quietly if an old
 * or shortened link was used, and give search engines the one true address.
 */
function present(page: Page) {
  const path = questionPath(page.question);
  if (location.pathname !== path) history.replaceState(history.state, '', path);
  applyMeta({ title: `${page.question.title} – Graphinity`, index: true }, path, import.meta.env.VITE_SITE_ORIGIN);
}

export default function Question({ id }: { id: string }) {
  const { state } = useSession();
  const [page, setPage] = useState<Page | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now] = useState(Date.now);

  async function reload() {
    const loaded = await api<Page>(`/questions/${id}`, { signedIn: 'if-possible' });
    setPage(loaded);
    present(loaded);
  }

  useEffect(() => {
    let live = true;
    api<Page>(`/questions/${id}`, { signedIn: 'if-possible' })
      .then(loaded => { if (live) { setPage(loaded); present(loaded); } })
      .catch((err: unknown) => { if (live) setError(err instanceof ApiError ? err.message : 'This question couldn’t load. Try again in a minute.'); });
    return () => { live = false; };
  }, [id]);

  // A new answer to this question appears without reloading the page.
  useEffect(() => onLive(e => {
    if (e.type === 'answered' && e.questionId === id) {
      api<Page>(`/questions/${id}`, { signedIn: 'if-possible' }).then(loaded => { setPage(loaded); }).catch(() => { /* next visit shows it */ });
    }
  }), [id]);

  if (error) {
    return <MessageScreen {...splitMessage(error)} />;
  }
  if (!page) return <main className="page stack-message"><p className="text-body status" role="status">Loading…</p></main>;

  const { question, answers, selection } = page;
  const me = state.status === 'ready' ? state.profile.handle : null;
  const asked = me === question.asker.handle;
  const answered = me !== null && answers.some(a => a.answerer.handle === me);

  return (
    <main className="page question-page">
      <div className="screen-top"><BackButton /></div>
      <article className="question">
        <h1 className="text-title1 question-heading">{question.title}</h1>
        <p className="text-footnote secondary question-meta">
          <span>{question.field.name}</span>
          {question.country && <span>{question.country.name}</span>}
          <span>Asked by <Link to={`/u/${encodeURIComponent(question.asker.handle)}`}>@{question.asker.handle}</Link></span>
          <span><time dateTime={question.createdAt}>{timeAgo(question.createdAt, now)}</time></span>
          {state.status === 'ready' && !asked && <span><ReportButton kind="question" id={question.id} /></span>}
        </p>
        {question.body && <p className="text-body post-body">{question.body}</p>}
        {question.hidden && <p className="text-subhead hidden-note" role="note">Hidden while moderators review reports about it. Only you can see it now.</p>}
      </article>

      <section className="answers" aria-labelledby="answers-heading">
        <h2 id="answers-heading" className="text-title3">
          {answers.length === 0 ? 'No answers yet' : answers.length === 1 ? '1 answer' : `${String(answers.length)} answers`}
        </h2>
        {asked && !selection && answers.length > 0 && (
          <p className="text-subhead secondary">Choose the answer that helped you. It earns them points.</p>
        )}
        {answers.length > 0 && (
          <ol className="answer-list">
            {/* The answer that helped comes first. */}
            {[...answers].sort((x, y) => Number(y.id === selection?.answerId) - Number(x.id === selection?.answerId)).map(a => (
              <li key={a.id} className={`answer${selection?.answerId === a.id ? ' is-picked' : ''}`}>
                <AnswerLabels answer={a} picked={selection?.answerId === a.id} correct={selection?.answerId === a.id ? selection.correct : null} />
                <p className="text-body post-body">{a.body}</p>
                <p className="text-footnote secondary question-meta">
                  <span><Link to={`/u/${encodeURIComponent(a.answerer.handle)}`}>@{a.answerer.handle}</Link></span>
                  <span><time dateTime={a.createdAt}>{timeAgo(a.createdAt, now)}</time></span>
                  {state.status === 'ready' && me !== a.answerer.handle && <span><ReportButton kind="answer" id={a.id} /></span>}
                </p>
                {a.hidden && <p className="text-subhead hidden-note" role="note">Hidden while moderators review reports about it.</p>}
                {asked && <AnswerActions questionId={question.id} answer={a} selection={selection} onChanged={reload} />}
              </li>
            ))}
          </ol>
        )}
      </section>

      {state.status === 'signedOut' && (
        <section className="answer-cta">
          <p className="text-body">Have you done this yourself? Sign in to answer.</p>
          <GoogleButton returnTo={location.pathname} />
        </section>
      )}
      {state.status === 'needsProfile' && (
        <section className="answer-cta">
          <p className="text-body">Set up your profile to answer. It takes a minute, and you’ll come straight back here.</p>
          <LinkButton to={`/welcome?next=${encodeURIComponent(location.pathname)}`}>Set up profile</LinkButton>
        </section>
      )}
      {state.status === 'ready' && asked && answers.length === 0 && (
        <p className="text-subhead secondary">This is your question. You’ll see answers here as people reply.</p>
      )}
      {state.status === 'ready' && !asked && !answered && <AnswerForm questionId={question.id} onAnswered={reload} />}
    </main>
  );
}

function AnswerForm({ questionId, onAnswered }: { questionId: string; onAnswered: () => Promise<void> }) {
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const length = charCount(body.trim());
  const canSend = length >= ANSWER.min && length <= ANSWER.max && !sending;

  async function send(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!canSend) return;
    setSending(true);
    setError(null);
    try {
      await api(`/questions/${questionId}/answers`, { method: 'POST', signedIn: true, body: { body } });
      await onAnswered();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Your answer couldn’t be posted. Try again in a minute.');
      setSending(false);
    }
  }

  const hint = length < ANSWER.min
    ? 'Share what you did and what happened.'
    : length > ANSWER.max - 500 ? `${String(ANSWER.max - length)} characters left` : '';

  return (
    <form className="answer-form" onSubmit={e => { void send(e); }}>
      <TextArea label="Your answer" value={body} onChange={setBody} rows={6} hint={hint} status={error ? { tone: 'bad', text: error } : null} />
      <Button type="submit" className="btn-block" disabled={!canSend}>{sending ? 'Posting…' : 'Post answer'}</Button>
    </form>
  );
}
