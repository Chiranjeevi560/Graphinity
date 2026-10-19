import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { SessionProvider } from './session.tsx';
import './styles/tokens.css';
import './styles/base.css';
import './components/components.css';
import './components/forms.css';
import './routes/routes.css';

// A deploy replaces the hashed files this page was built against, so the
// next screen someone opens may 404. Reload once to pick up the new version.
// The time guard stops a reload loop if the new version is broken too; the
// error then reaches the error boundary, which explains what to do.
window.addEventListener('vite:preloadError', event => {
  // Offline, a reload can only fail (to the browser's own error page). The
  // screen that needed the file says so instead, and tries again online.
  if (!navigator.onLine) return;
  const key = 'graphinity:reloaded-at';
  // Without storage the guard can't remember reloading, so a broken deploy
  // would reload forever: show the error screen instead.
  try {
    if (Date.now() - (Number(sessionStorage.getItem(key)) || 0) < 10_000) return;
    sessionStorage.setItem(key, String(Date.now()));
  } catch {
    return;
  }
  event.preventDefault();
  location.reload();
});

// iOS Safari only applies :active styles when a touch listener exists, and
// press feedback must appear on touch-down.
document.addEventListener('touchstart', () => {}, { passive: true });

const root = document.getElementById('root');
if (!root) throw new Error('index.html is missing #root');
createRoot(root).render(
  <StrictMode>
    <SessionProvider>
      <App />
    </SessionProvider>
  </StrictMode>,
);
