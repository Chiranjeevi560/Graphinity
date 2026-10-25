import { useEffect, useRef, useState } from 'react';
import { BackButton } from '../components/BackButton.tsx';
import { LinkButton } from '../components/Button.tsx';
import { LoadFailed } from '../components/Message.tsx';
import { SearchField } from '../components/SearchField.tsx';
import { ApiError } from '../lib/api.ts';
import { questionPath, timeAgo } from '../lib/questions.ts';
import { Link } from '../lib/router.ts';
import {
  correctionWords,
  lastSearch,
  openedFromSearch,
  QUERY_MIN,
  reasonWords,
  rememberSearch,
  clearPendingSearch,
  pendingSearch,
  type SearchResponse,
} from '../lib/search.ts';
import { charCount } from '../lib/questions.ts';
import { api, useSession } from '../session.tsx';

type State =
  | { status: 'idle' }
  | { status: 'searching'; query: string }
  | { status: 'done'; query: string; response: SearchResponse }
  | { status: 'failed'; query: string; error: ApiError };

const sendOpen = (path: string, body: { dwellMs?: number }, keepalive: boolean) =>
  api(path, { method: 'PUT', signedIn: true, body, keepalive });

/** Searching every question asked so far (ADR 0015 part 4). Reading needs no account. */
export default function Search() {
  const { state: session } = useSession();
  // Back from a question: the same search, as it was.
  const [restored] = useState(lastSearch);
  const [pending] = useState(pendingSearch);
  const [query, setQuery] = useState(pending ?? restored?.query ?? '');
  const [state, setState] = useState<State>(
    restored && !pending ? { status: 'done', query: restored.query, response: restored.response } : { status: 'idle' },
  );
  const [now] = useState(Date.now);
  const latest = useRef(0);

  async function run(text: string) {
    if (charCount(text) < QUERY_MIN) return;
    const ticket = ++latest.current;
    setState({ status: 'searching', query: text });
    try {
      const response = await api<SearchResponse>('/search', {
        method: 'POST',
        body: { query: text },
        signedIn: 'if-possible',
      });
      // A newer search was submitted meanwhile: its answer is the one that counts.
      if (ticket !== latest.current) return;
      rememberSearch(text, response);
      setState({ status: 'done', query: text, response });
    } catch (err) {
      if (ticket !== latest.current) return;
      const error = err instanceof ApiError ? err : new ApiError(0, 'unknown', 'Search couldn’t finish. Try again.');
      setState({ status: 'failed', query: text, error });
    }
  }

  // Arrived from the home page's field: search straight away, once.
  const started = useRef(false);
  useEffect(() => {
    if (!pending || started.current) return;
    started.current = true;
    clearPendingSearch();
    void run(pending);
  });

  return (
    <main className="page search-page">
      <div className="onboarding-top">
        <BackButton />
      </div>
      <h1 className="text-title1">Search</h1>
      <SearchField
        value={query}
        onChange={setQuery}
        onSubmit={text => {
          void run(text);
        }}
        focusFirst={!restored && !pending}
        busy={state.status === 'searching'}
      />
      <Results state={state} now={now} signedIn={session.status === 'ready'} onRetry={q => void run(q)} />
    </main>
  );
}

function Results({
  state,
  now,
  signedIn,
  onRetry,
}: {
  state: State;
  now: number;
  signedIn: boolean;
  onRetry: (query: string) => void;
}) {
  if (state.status === 'idle')
    return (
      <p className="text-body secondary">
        Search everything people have asked: in your own words, with codes like “BOE-II”, or with a typo.
      </p>
    );
  if (state.status === 'searching')
    return (
      <p className="text-body secondary status" role="status">
        Searching…
      </p>
    );
  if (state.status === 'failed') {
    const { error } = state;
    // Too many searches, or search paused: the server's own words say what to do.
    if (error.status === 429 || error.code === 'search_off')
      return (
        <p className="form-note tone-bad" role="alert">
          {error.message}
        </p>
      );
    return (
      <LoadFailed
        error={error}
        onRetry={() => {
          onRetry(state.query);
        }}
        inline
      />
    );
  }
  const { response, query } = state;
  const corrected = correctionWords(response.corrections);
  return (
    <section className="search-results" aria-labelledby="results-heading">
      <h2 id="results-heading" className="text-footnote secondary search-count" role="status">
        {response.results.length === 0
          ? `Nothing matches “${query}” yet.`
          : response.results.length === 1
            ? '1 question'
            : `${String(response.results.length)} questions`}
      </h2>
      {corrected && <p className="text-footnote secondary">{corrected}</p>}
      {!response.meaning && response.results.length > 0 && (
        <p className="text-footnote secondary">Matched by words only right now.</p>
      )}
      {response.results.length === 0 ? (
        <div className="search-empty">
          <p className="text-body secondary">
            Someone has probably lived it. Ask, and it goes to people with that experience.
          </p>
          {signedIn && <LinkButton to="/ask">Ask a question</LinkButton>}
        </div>
      ) : (
        <ul className="question-list">
          {response.results.map((r, i) => (
            <li key={r.id} className="question-row">
              <Link
                to={questionPath(r)}
                className="question-link"
                onClick={() => {
                  if (response.searchId)
                    openedFromSearch(sendOpen, { searchId: response.searchId, position: i + 1, questionId: r.id });
                }}
              >
                <span className="text-headline question-title">{r.title}</span>
                <span className="text-footnote secondary question-meta">
                  <span>{r.field.name}</span>
                  <span>{r.answerCount === 1 ? '1 answer' : `${String(r.answerCount)} answers`}</span>
                  {r.lastAnsweredAt && <span>answered {timeAgo(r.lastAnsweredAt, now)}</span>}
                </span>
                <span className="text-footnote search-reasons">{reasonWords(r.reasons)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
