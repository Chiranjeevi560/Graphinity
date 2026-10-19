import { useCallback, useEffect, useMemo, useState } from 'react';
import type { LivingGraph as LivingGraphType } from '../components/LivingGraph.tsx';
import { LinkButton } from '../components/Button.tsx';
import { GoogleButton } from '../components/GoogleButton.tsx';
import { Inbox } from '../components/Inbox.tsx';
import { LoadFailed } from '../components/Message.tsx';
import { Link } from '../lib/router.ts';
import { QuestionList } from '../components/QuestionList.tsx';
import type { GraphData } from '../lib/graph-layout.ts';
import { graphCaption } from '../lib/graph-words.ts';
import { retrySession, useSession } from '../session.tsx';
import { useRetryWhenOnline } from '../lib/retry.ts';
import { useLoad } from '../use-load.ts';

/** Everyone, as the graph. Signed in, the viewer is in it too. */
function HomeGraph({ mine }: { mine: string[] | null }) {
  const { data } = useLoad<GraphData>('/graph');
  // Its code arrives after the page's text: the words are what people read
  // first. If it can't download (offline), the page carries on without it
  // and it appears by itself once back online.
  const [Graph, setGraph] = useState<typeof LivingGraphType | null>(null);
  const [failed, setFailed] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!data || Graph) return;
    let live = true;
    import('../components/LivingGraph.tsx').then(
      m => {
        if (live) setGraph(() => m.LivingGraph);
      },
      (err: unknown) => {
        if (live) setFailed(err);
      },
    );
    return () => {
      live = false;
    };
  }, [data, Graph, attempt]);
  const retry = useCallback(() => {
    setFailed(null);
    setAttempt(a => a + 1);
  }, []);
  useRetryWhenOnline(failed, retry);

  const you = useMemo(() => {
    if (!data || !mine) return undefined;
    const at = mine.map(slug => data.fields.findIndex(f => f.slug === slug)).filter(i => i >= 0);
    return at.length ? at : undefined;
  }, [data, mine]);
  // The space is kept while loading, so nothing below jumps when it appears.
  // If the data can't load, the page works without it; the questions say what's wrong.
  if (!data || !Graph) {
    return (
      <div className="living-graph" aria-hidden="true">
        <div className="living-graph-canvas" />
        <p className="text-footnote">&nbsp;</p>
      </div>
    );
  }
  return <Graph data={data} you={you} caption={graphCaption(data)} />;
}

export default function Home() {
  const { state } = useSession();
  const mine = useMemo(() => (state.status === 'ready' ? state.profile.fields.map(f => f.slug) : null), [state]);
  return (
    <main className="page home">
      {state.status === 'ready' ? (
        // Signed in: their own things first, not the pitch they've already read.
        <h1 className="visually-hidden">Graphinity</h1>
      ) : (
        <>
          <h1 className="text-large">Ask once. Reach people who’ve done it.</h1>
          <p className="text-body secondary">
            Your question goes to people with real experience of it. You choose the answer that helped.
          </p>
        </>
      )}
      <HomeGraph mine={mine} />
      {state.status === 'signedOut' && (
        <div className="home-action">
          <GoogleButton />
          <p className="text-footnote secondary">
            Google only confirms who you are. You choose the name people see, and we never show your Google name or
            email. By continuing you agree to the <Link to="/terms">terms</Link> and <Link to="/privacy">privacy</Link>{' '}
            policy.
          </p>
        </div>
      )}
      {state.status === 'ready' && (
        <div className="home-action">
          <LinkButton to="/ask">Ask a question</LinkButton>
        </div>
      )}
      {state.status === 'unreachable' && (
        <div className="home-action">
          <LoadFailed error={state.error} onRetry={retrySession} inline />
        </div>
      )}
      {state.status === 'ready' && <Inbox />}
      <section className="home-questions" aria-labelledby="recent-heading">
        <h2 id="recent-heading" className="text-title3">
          Recent questions
        </h2>
        <QuestionList />
      </section>
      <footer className="site-footer text-footnote secondary">
        <Link to="/privacy">Privacy</Link>
        <Link to="/terms">Terms</Link>
      </footer>
    </main>
  );
}
