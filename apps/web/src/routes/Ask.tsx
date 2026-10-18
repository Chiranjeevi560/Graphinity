import { useEffect, useState, type SubmitEvent } from 'react';
import { Button } from '../components/Button.tsx';
import { SelectField, TextArea, TextField } from '../components/Form.tsx';
import { ApiError } from '../lib/api.ts';
import { charCount, DETAILS_MAX, questionPath, TITLE } from '../lib/questions.ts';
import { Link, navigate } from '../lib/router.ts';
import { api, type Profile } from '../session.tsx';
import { useMeta } from './profile-form.ts';

interface Draft { title: string; details: string; field: string; country: string }

// Kept while the app is open, so opening a similar question and coming back
// doesn't lose what was typed. Gone on reload or once posted.
let draft: Draft | null = null;

interface Similar { id: string; title: string; answerCount: number }

/** Questions like the one being typed, once the person pauses. */
function useSimilar(title: string) {
  const query = title.trim();
  const [answer, setAnswer] = useState<{ query: string; questions: Similar[] } | null>(null);
  const ready = charCount(query) >= 10;
  useEffect(() => {
    if (!ready) return;
    let live = true;
    const timer = setTimeout(() => {
      api<{ questions: Similar[] }>(`/questions/similar?q=${encodeURIComponent(query)}`)
        .then(res => { if (live) setAnswer({ query, questions: res.questions }); })
        // Matching is a help, not a step: if it fails, asking still works.
        .catch(() => { if (live) setAnswer({ query, questions: [] }); });
    }, 350);
    return () => { live = false; clearTimeout(timer); };
  }, [query, ready]);
  // Keep showing the last matches while new ones load, so the list doesn't flicker.
  return ready ? answer?.questions ?? [] : [];
}

export default function Ask({ profile }: { profile: Profile }) {
  const { meta, error: metaError } = useMeta();
  const [title, setTitle] = useState(draft?.title ?? '');
  const [details, setDetails] = useState(draft?.details ?? '');
  const [field, setField] = useState(draft?.field ?? profile.fields[0]?.slug ?? '');
  const [country, setCountry] = useState(draft?.country ?? '');
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState<{ on: 'title' | 'details' | 'form'; text: string } | null>(null);
  const similar = useSimilar(title);

  useEffect(() => { draft = { title, details, field, country }; }, [title, details, field, country]);

  if (metaError) return <main className="page stack-message"><p className="text-body" role="alert">{metaError}</p></main>;
  if (!meta) return <main className="page stack-message"><p className="text-body status" role="status">Loading…</p></main>;

  const titleLength = charCount(title.trim());
  const detailsLength = charCount(details.trim());
  const canPost = titleLength >= TITLE.min && titleLength <= TITLE.max && detailsLength <= DETAILS_MAX && field !== '' && !posting;

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
      draft = null;
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
        {similar.length > 0 && (
          <section className="similar" aria-label="Similar questions already asked">
            <h2 className="text-subhead secondary">Already asked?</h2>
            <ul className="similar-list">
              {similar.map(q => (
                <li key={q.id}>
                  <Link to={questionPath(q)} className="similar-link">
                    <span className="text-callout">{q.title}</span>
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
          label="Field"
          value={field}
          onChange={setField}
          options={[...(field ? [] : [{ value: '', label: 'Choose a field' }]), ...meta.fields.map(f => ({ value: f.slug, label: f.name }))]}
        />
        <SelectField
          label="About a country"
          value={country}
          onChange={setCountry}
          hint="People who live there see it first."
          options={[{ value: '', label: 'Anywhere' }, ...meta.countries.map(c => ({ value: c.code, label: c.name }))]}
        />
        {error?.on === 'form' && <p className="form-note tone-bad" role="alert">{error.text}</p>}
        <Button type="submit" className="btn-block" disabled={!canPost}>{posting ? 'Posting…' : 'Post question'}</Button>
      </form>
    </main>
  );
}
