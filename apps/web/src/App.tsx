import { Component, lazy, Suspense, useEffect, type ReactNode } from 'react';
import { Button } from './components/Button.tsx';
import { Avatar } from './components/Identity.tsx';
import { applyMeta, pageMeta } from './lib/meta.ts';
import { Link, navigate, usePath } from './lib/router.ts';
import { useSession, type SessionState } from './session.tsx';

// Each screen is its own chunk, so a phone downloads only what it shows.
const Home = lazy(() => import('./routes/Home.tsx'));
const AuthCallback = lazy(() => import('./routes/AuthCallback.tsx'));
const Welcome = lazy(() => import('./routes/Welcome.tsx'));
const Me = lazy(() => import('./routes/Me.tsx'));
const EditProfile = lazy(() => import('./routes/EditProfile.tsx'));
const PublicProfile = lazy(() => import('./routes/PublicProfile.tsx'));
const Ask = lazy(() => import('./routes/Ask.tsx'));
const Question = lazy(() => import('./routes/Question.tsx'));
const Goodbye = lazy(() => import('./routes/Goodbye.tsx'));
const NotFound = lazy(() => import('./routes/NotFound.tsx'));
// A gallery of the design system for reviewing it; never part of a production build.
const Design = import.meta.env.DEV ? lazy(() => import('./routes/Design.tsx')) : null;

/** Sends people where they belong: no setup screen once set up, no profile pages when signed out. */
function Redirect({ to }: { to: string }) {
  useEffect(() => { navigate(to, { replace: true }); }, [to]);
  return null;
}

function route(path: string, state: SessionState): ReactNode {
  if (path === '/auth/callback') return <AuthCallback />;
  if (path === '/goodbye') return <Goodbye />;
  const profileMatch = /^\/u\/([^/]+)$/.exec(path);
  if (profileMatch?.[1]) {
    // A malformed link (e.g. /u/%E0) can't be decoded: treat it as not found
    // instead of crashing to the error screen.
    const handle = safeDecode(profileMatch[1]);
    return handle === null ? <NotFound /> : <PublicProfile handle={handle} />;
  }
  // Questions are public: readable before sign-in finishes loading.
  const questionMatch = /^\/q\/([1-9][0-9]{0,15})(?:\/[^/]*)?$/.exec(path);
  if (questionMatch?.[1]) return <Question id={questionMatch[1]} />;
  if (Design && path === '/design') return <Design />;

  // Everything below depends on who is signed in.
  if (state.status === 'loading') return null;
  if (state.status === 'needsProfile' && path !== '/welcome') return <Redirect to="/welcome" />;

  switch (path) {
    case '/':
      return <Home />;
    case '/welcome':
      if (state.status === 'needsProfile') return <Welcome />;
      return <Redirect to="/" />;
    case '/me':
      return state.status === 'ready' ? <Me profile={state.profile} /> : <Redirect to="/" />;
    case '/ask':
      return state.status === 'ready' ? <Ask profile={state.profile} /> : <Redirect to="/" />;
    case '/me/edit':
      return state.status === 'ready' ? <EditProfile profile={state.profile} /> : <Redirect to="/" />;
    default:
      return <NotFound />;
  }
}

function safeDecode(part: string): string | null {
  try { return decodeURIComponent(part); } catch { return null; }
}

export function App() {
  const path = usePath();
  const { state } = useSession();
  useEffect(() => { applyMeta(pageMeta(path), path, import.meta.env.VITE_SITE_ORIGIN); }, [path]);
  return (
    <>
      <header className="bar">
        <div className="bar-inner">
          <Link to="/" className="wordmark" aria-label="Graphinity home">
            <Glyph />
            <span>Graphinity</span>
          </Link>
          {state.status === 'ready' && (
            <Link to="/me" className="bar-avatar" aria-label={`Your profile, @${state.profile.handle}`}>
              <Avatar handle={state.profile.handle} />
            </Link>
          )}
        </div>
      </header>
      <ErrorBoundary>
        {/* No spinner: screens are small, and a flash of one is worse than a blank frame. */}
        <Suspense fallback={null}>
          <div className="route" key={path}>{route(path, state)}</div>
        </Suspense>
      </ErrorBoundary>
    </>
  );
}

function Glyph() {
  // Three people, connected: the graph.
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M6 7.5 L18 7.5 L12 18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <circle cx="6" cy="7.5" r="3" fill="currentColor" />
      <circle cx="18" cy="7.5" r="3" fill="currentColor" />
      <circle cx="12" cy="18" r="3" fill="currentColor" />
    </svg>
  );
}

class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="page stack-message">
        <h1 className="text-title2">This page couldn’t load</h1>
        <p className="text-body secondary">Check your internet connection, then reload the page.</p>
        <Button onClick={() => { location.reload(); }}>Reload</Button>
      </main>
    );
  }
}
