import { useEffect, useState, type SubmitEvent } from 'react';
import { Button, LinkButton } from '../components/Button.tsx';
import { TextArea } from '../components/Form.tsx';
import { BackButton } from '../components/BackButton.tsx';
import { GoogleButton } from '../components/GoogleButton.tsx';
import { LoadFailed, MessageScreen, splitMessage } from '../components/Message.tsx';
import { ReportButton } from '../components/ReportButton.tsx';
import { ApiError } from '../lib/api.ts';
import { drafts } from '../lib/drafts.ts';
import { onLive } from '../lib/live.ts';
import { applyMeta } from '../lib/meta.ts';
import { ANSWER, charCount, MEDAL_NAMES, questionPath, timeAgo, type Answer, type Consensus, type QuestionSummary, type Selection } from '../lib/questions.ts';
import { AnswerActions, AnswerLabels } from '../components/AnswerActions.tsx';
import { ConsensusBar } from '../components/ConsensusBar.tsx';
import { RoutingGraph } from '../components/RoutingGraph.tsx';
import { SquircleLayers } from '../components/Squircle.tsx';
import { routingLine } from '../lib/graph-words.ts';
import { takeJustAsked } from '../lib/just-asked.ts';
import { Link } from '../lib/router.ts';
import { api, useSession } from '../session.tsx';
import { useLoad } from '../use-load.ts';

interface WhyYou { sameCountry: boolean | null; fieldPoints: number | null; trustPct: number | null; answeredPct: number | null; newcomer: boolean | null }
interface Page {
  question: QuestionSummary & { body: string; hidden: boolean };
  answers: Array<Answer & { hidden: boolean }>;
  selection: Selection | null;
  /** Once 3 answers report an amount (spec §11.4). */
  consensus: Consensus | null;
  /** The asker only, once it went out. */
  routing?: { waves: number; asked: number | null; inCountry: number | null };
  /** Someone it was put to only. */
  whyYou?: WhyYou;
}

/** Routing that hasn't happened this long after asking means nobody could be asked. */
const SEND_GRACE_MS = 90_000;

/** "Why you got this", in the words of what the score saw. */
function whyLines(why: WhyYou, page: Page): string[] {
  const lines = [`You know ${page.question.field.name}`];
  if (why.sameCountry && page.question.country) lines.push(`You live in ${page.question.country.name}`);
  if (why.fieldPoints) lines.push(`${String(why.fieldPoints)} points in ${page.question.field.name}`);
  if (why.answeredPct !== null) lines.push(`You answer ${String(why.answeredPct)}% of what’s sent to you`);
  if (why.trustPct !== null) lines.push(`${String(why.trustPct)}% of your picked answers here turned out right`);
  if (why.newcomer) lines.push('You’re new: some places in every wave are kept for new members');
  return lines;
}

/** Where the asker's question went, or why it hasn't gone anywhere. */
function routingCaption(page: Page, now: number): string {
  const { question, routing, answers } = page;
  if (routing) {
    const line = routingLine(routing, question.field.name, question.country?.name ?? null);
    return answers.length > 0 ? `${line} · ${answers.length === 1 ? '1 answer' : `${String(answers.length)} answers`} so far` : line;
  }
  if (now - Date.parse(question.createdAt) < SEND_GRACE_MS) return `Finding people who know ${question.field.name}…`;
  return `Nobody who knows ${question.field.name} could be asked yet. It stays open here for anyone to answer.`;
}

/**
 * The address carries the title's current wording: fix it quietly if an old
 * or shortened link was used, and give search engines the one true address.
 */
function present(page: Page) {
  const path = questionPath(page.question);
  if (location.pathname !== path) history.replaceState(history.state, '', path);
  // Spec §19.2: only once someone has answered does it belong in search results.
  applyMeta({ title: `${page.question.title} – Graphinity`, index: page.answers.some(a => !a.hidden) }, path, import.meta.env.VITE_SITE_ORIGIN);
}

export default function Question({ id }: { id: string }) {
  const { state } = useSession();
  const { data: page, error, retry, setData: setPage } = useLoad<Page>(`/questions/${id}`, 'if-possible');
  const [now, setNow] = useState(Date.now);
  // Asked from this tab moments ago: its first wave is shown leaving.
  const [fresh] = useState(() => takeJustAsked(id));

  // Fix the address and the tab title once the question is here.
  useEffect(() => { if (page) present(page); }, [page]);

  async function reload() {
    setPage(await api<Page>(`/questions/${id}`, { signedIn: 'if-possible' }));
  }

  // A new answer, or the question going out to more people, appears
  // without reloading the page.
  useEffect(() => onLive(e => {
    if ((e.type === 'answered' || e.type === 'sent') && e.questionId === id) {
      api<Page>(`/questions/${id}`, { signedIn: 'if-possible' }).then(page => { setNow(Date.now()); setPage(page); }).catch(() => { /* next visit shows it */ });
    }
  }), [id, setPage]);

  // While it's being sent, check back once the grace is over, so "Finding
  // people…" never stays up when nobody could be asked.
  const waiting = page !== null && !page.routing && now - Date.parse(page.question.createdAt) < SEND_GRACE_MS;
  useEffect(() => {
    if (!waiting) return;
    const timer = setTimeout(() => { void reload().then(() => { setNow(Date.now()); }, () => { setNow(Date.now()); }); }, SEND_GRACE_MS / 3);
    return () => { clearTimeout(timer); };
  });

  // Only a question the server says isn't there is "gone"; anything else can be tried again.
  if (error?.status === 404) return <MessageScreen {...splitMessage(error.message)} />;
  if (error) return <LoadFailed error={error} onRetry={retry} />;
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

      {asked && (
        <RoutingGraph asked={page.routing ? page.routing.asked : undefined} answers={answers.length} fresh={fresh} caption={routingCaption(page, now)} />
      )}
      {page.whyYou && (
        <section className="why-you sq-host" aria-labelledby="why-heading">
          <SquircleLayers radius={1.25} />
          <h2 id="why-heading" className="text-headline">Why you got this</h2>
          <ul className="text-subhead secondary">
            {whyLines(page.whyYou, page).map(line => <li key={line}>{line}</li>)}
          </ul>
        </section>
      )}

      <section className="answers" aria-labelledby="answers-heading">
        <h2 id="answers-heading" className="text-title3">
          {answers.length === 0 ? 'No answers yet' : answers.length === 1 ? '1 answer' : `${String(answers.length)} answers`}
        </h2>
        {asked && !selection && answers.length > 0 && (
          <p className="text-subhead secondary">Choose the answer that helped you. It earns them points.</p>
        )}
        {page.consensus && <ConsensusBar consensus={page.consensus} />}
        {answers.length > 0 && (
          <ol className="answer-list">
            {/* The answer that helped comes first; the rest in the server's order (spec §11.5). */}
            {[...answers].sort((x, y) => Number(y.id === selection?.answerId) - Number(x.id === selection?.answerId)).map(a => (
              <li key={a.id} id={`answer-${a.id}`} className={`answer${selection?.answerId === a.id ? ' is-picked' : ''}`}>
                <AnswerLabels answer={a} picked={selection?.answerId === a.id} correct={selection?.answerId === a.id ? selection.correct : null} />
                {a.minorityPinned && <p className="minority-badge text-footnote">Different outcome · kept visible</p>}
                <p className="text-body post-body">{a.body}</p>
                <p className="text-footnote secondary question-meta">
                  <span><Link to={`/u/${encodeURIComponent(a.answerer.handle)}`}>@{a.answerer.handle}</Link></span>
                  {/* Who they are as a source here (spec §3.1: a few tokens, read at a glance). */}
                  {a.author.medal && <span className={`medal medal-${a.author.medal}`}>{MEDAL_NAMES[a.author.medal]}</span>}
                  {a.author.reputation > 0 && <span>Reputation {Math.round(a.author.reputation)}</span>}
                  {a.author.accepted > 0 && <span>{a.author.accepted === 1 ? '1 pick' : `${String(a.author.accepted)} picks`} in {question.field.name}</span>}
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

const isAnswerDraft = (v: unknown): v is { body: string } => typeof v === 'object' && v !== null && typeof (v as { body?: unknown }).body === 'string';

function AnswerForm({ questionId, onAnswered }: { questionId: string; onAnswered: () => Promise<void> }) {
  // Whatever was typed before a reload, a crash or a failed post (lib/drafts.ts).
  const key = `answer.${questionId}`;
  const [body, setBody] = useState(() => drafts.load(key, isAnswerDraft)?.body ?? '');
  useEffect(() => { drafts.save(key, { body }, d => d.body.trim() === ''); }, [key, body]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [posted, setPosted] = useState(false);
  const length = charCount(body.trim());
  const canSend = length >= ANSWER.min && length <= ANSWER.max && !sending;

  async function send(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!canSend) return;
    setSending(true);
    setError(null);
    try {
      await api(`/questions/${questionId}/answers`, { method: 'POST', signedIn: true, body: { body } });
      drafts.save(key, null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Your answer couldn’t be posted. Try again in a minute.');
      setSending(false);
      return;
    }
    // Posted. If the page can't update, say so rather than inviting a second post.
    await onAnswered().catch(() => { setPosted(true); });
  }

  if (posted) return <p className="text-body" role="status">Your answer is posted. Reload the page to see it.</p>;

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
