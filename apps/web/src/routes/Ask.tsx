import { useEffect, useState, type SubmitEvent } from 'react';
import { Button, LinkButton } from '../components/Button.tsx';
import { SquircleLayers } from '../components/Squircle.tsx';
import { SelectField, TextArea, TextField } from '../components/Form.tsx';
import { LoadFailed } from '../components/Message.tsx';
import { ApiError } from '../lib/api.ts';
import { charCount, DETAILS_MAX, questionPath, TITLE } from '../lib/questions.ts';
import { drafts } from '../lib/drafts.ts';
import { markJustAsked } from '../lib/just-asked.ts';
import { Link, navigate } from '../lib/router.ts';
import { api, type Profile } from '../session.tsx';
import { useMeta } from './profile-form.ts';

interface Draft { title: string; details: string; field: string; country: string }

const isDraft = (v: unknown): v is Draft =>
  typeof v === 'object' && v !== null && (['title', 'details', 'field', 'country'] as const).every(k => typeof (v as Record<string, unknown>)[k] === 'string');

interface Similar { id: string; title: string; answerCount: number }
interface Precheck { verdict: 'duplicate' | 'related' | 'clear'; questions: Similar[] }

/**
 * Has this been asked already? Asked of the server once the person pauses
 * for 250 ms (spec §7.2 Screen 2), by meaning and by words, within the
 * chosen topic when there is one.
 */
function usePrecheck(title: string, field: string): Precheck {
  const query = title.trim();
  const [answer, setAnswer] = useState<{ key: string; result: Precheck } | null>(null);
  const ready = charCount(query) >= 10;
  const key = `${field}\n${query}`;
  useEffect(() => {
    if (!ready) return;
    let live = true;
    const timer = setTimeout(() => {
      api<Precheck>('/questions/precheck', { method: 'POST', body: { title: query, ...(field ? { field } : {}) } })
        .then(result => { if (live) setAnswer({ key, result }); })
        // Matching is a help, not a step: if it fails, asking still works.
        .catch(() => { if (live) setAnswer({ key, result: { verdict: 'clear', questions: [] } }); });
    }, 250);
    return () => { live = false; clearTimeout(timer); };
  }, [key, query, field, ready]);
  // Keep showing the last matches while new ones load, so the list doesn't flicker.
  return ready && answer ? answer.result : { verdict: 'clear', questions: [] };
}

export default function Ask({ profile }: { profile: Profile }) {
  const { meta, error: metaError, retry: retryMeta } = useMeta();
  // Whatever was typed before a reload, a crash or a failed post (lib/drafts.ts).
  const [saved] = useState(() => drafts.load('ask', isDraft));
  const [title, setTitle] = useState(saved?.title ?? '');
  const [details, setDetails] = useState(saved?.details ?? '');
  // No topic chosen for them: a wrong guess would send the question to the wrong people.
  const [field, setField] = useState(saved?.field ?? '');
  const [country, setCountry] = useState(saved?.country ?? '');
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState<{ on: 'title' | 'details' | 'form'; text: string } | null>(null);
  const precheck = usePrecheck(title, field);
  // "Mine is different": said once for the question as it was then.
  const [differentFrom, setDifferentFrom] = useState<string | null>(null);
  const match = precheck.verdict === 'duplicate' ? precheck.questions[0] : undefined;
  const intercepted = match !== undefined && differentFrom !== match.id;
  const similar = intercepted ? precheck.questions.slice(1) : precheck.questions;

  useEffect(() => {
    drafts.save('ask', { title, details, field, country }, d => d.title.trim() === '' && d.details.trim() === '');
  }, [title, details, field, country]);

  if (metaError) return <LoadFailed error={metaError} onRetry={retryMeta} />;
  if (!meta) return <main className="page stack-message"><p className="text-body status" role="status">Loading…</p></main>;

  const titleLength = charCount(title.trim());
  const detailsLength = charCount(details.trim());
  const canPost = titleLength >= TITLE.min && titleLength <= TITLE.max && detailsLength <= DETAILS_MAX && field !== '' && !posting && !intercepted;
  // Why the button is greyed out, so it never just sits there.
  const missing = titleLength < TITLE.min ? `Write your question in full, at least ${String(TITLE.min)} characters.`
    : field === '' ? 'Choose a topic so it reaches the right people.'
    : intercepted ? 'Read the answers above, or say yours is different.' : null;
  // Their own topics first: the likeliest choice is one tap away.
  const mine = new Set(profile.fields.map(f => f.slug));
  const topics = [...meta.fields].sort((a, b) => Number(mine.has(b.slug)) - Number(mine.has(a.slug)));

  async function post(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!canPost) return;
    setPosting(true);
    setError(null);
    try {
      const res = await api<{ question: { id: string } }>('/questions', {
        method: 'POST', signedIn: true,
        body: { title, details, field, country: country || null },
      });
      drafts.save('ask', null);
      markJustAsked(res.question.id);
      navigate(questionPath({ id: res.question.id, title }), { replace: true });
    } catch (err) {
      const text = err instanceof ApiError ? err.message : 'Your question couldn’t be posted. Try again in a minute.';
      const on = err instanceof ApiError && err.code === 'invalid_title' ? 'title' : err instanceof ApiError && err.code === 'invalid_details' ? 'details' : 'form';
      setError({ on, text });
      setPosting(false);
    }
  }

  return (
    <main className="page">
      <form className="edit-form" onSubmit={e => { void post(e); }}>
        <div className="onboarding-top">
          <Link to="/" className="btn btn-plain">Cancel</Link>
        </div>
        <h1 className="text-title1">Ask a question</h1>
        <TextField
          label="Your question"
          value={title}
          onChange={setTitle}
          maxLength={TITLE.max * 2}
          enterKeyHint="next"
          status={error?.on === 'title' ? { tone: 'bad', text: error.text } : null}
          hint={titleLength > TITLE.max - 20 ? `${String(TITLE.max - titleLength)} characters left` : 'Ask it the way you’d ask a friend who’s done it.'}
        />
        {match && intercepted && (
          <section className="match-card sq-host" aria-labelledby="match-heading">
            <SquircleLayers radius={1.25} />
            <h2 id="match-heading" className="text-headline">This was asked and answered recently</h2>
            <Link to={questionPath(match)} className="question-link">
              <span className="text-body question-title">{match.title}</span>
              <span className="text-footnote secondary">{match.answerCount === 1 ? '1 answer' : `${String(match.answerCount)} answers`}</span>
            </Link>
            <div className="match-actions">
              <LinkButton to={questionPath(match)}>Read the answers</LinkButton>
              <button type="button" className="btn btn-plain" onClick={() => { setDifferentFrom(match.id); }}>Mine is different</button>
            </div>
          </section>
        )}
        {similar.length > 0 && (
          <section className="similar" aria-label="Similar questions already asked">
            <h2 className="text-subhead">Already asked? One of these may have your answer.</h2>
            <ul className="question-list">
              {similar.slice(0, 3).map(q => (
                <li key={q.id} className="question-row">
                  <Link to={questionPath(q)} className="question-link">
                    <span className="text-headline question-title">{q.title}</span>
                    <span className="text-footnote secondary">{q.answerCount === 1 ? '1 answer' : `${String(q.answerCount)} answers`}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}
        <TextArea
          label="Details (optional)"
          value={details}
          onChange={setDetails}
          rows={5}
          status={error?.on === 'details' ? { tone: 'bad', text: error.text } : null}
          hint={detailsLength > DETAILS_MAX - 200 ? `${String(DETAILS_MAX - detailsLength)} characters left` : 'What you’ve tried, and what would help.'}
        />
        <SelectField
          label="Topic"
          value={field}
          onChange={setField}
          options={[{ value: '', label: 'Choose a topic' }, ...topics.map(f => ({ value: f.slug, label: f.name }))]}
        />
        <SelectField
          label="About a country"
          value={country}
          onChange={setCountry}
          hint="People who live there see it first."
          options={[{ value: '', label: 'Anywhere' }, ...meta.countries.map(c => ({ value: c.code, label: c.name }))]}
        />
        {error?.on === 'form' && <p className="form-note tone-bad" role="alert">{error.text}</p>}
        {missing && !posting && <p className="form-note">{missing}</p>}
        <Button type="submit" className="btn-block" disabled={!canPost}>{posting ? 'Posting…' : 'Post question'}</Button>
      </form>
    </main>
  );
}
