import { Component, lazy, Suspense, type ReactNode } from 'react';
import { Button } from './components/Button.tsx';
import { Link, usePath } from './lib/router.ts';

// Each screen is its own chunk, so a phone downloads only what it shows.
const Home = lazy(() => import('./routes/Home.tsx'));
const NotFound = lazy(() => import('./routes/NotFound.tsx'));
// A gallery of the design system for reviewing it; never part of a production build.
const Design = import.meta.env.DEV ? lazy(() => import('./routes/Design.tsx')) : null;

function route(path: string) {
  if (path === '/') return <Home />;
  if (Design && path === '/design') return <Design />;
  return <NotFound />;
}

export function App() {
  const path = usePath();
  return (
    <>
      <header className="bar">
        <div className="bar-inner">
          <Link to="/" className="wordmark" aria-label="Graphinity home">
            <Glyph />
            <span>Graphinity</span>
          </Link>
        </div>
      </header>
      <ErrorBoundary>
        {/* No spinner: screens are small, and a flash of one is worse than a blank frame. */}
        <Suspense fallback={null}>
          <div className="route" key={path}>{route(path)}</div>
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
        <Button onClick={() => location.reload()}>Reload</Button>
      </main>
    );
  }
}
