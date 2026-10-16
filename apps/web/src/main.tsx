import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import './styles/tokens.css';
import './styles/base.css';
import './components/components.css';
import './routes/routes.css';

// A deploy replaces the hashed files this page was built against, so the
// next screen someone opens may 404. Reload once to pick up the new version.
// The time guard stops a reload loop if the new version is broken too; the
// error then reaches the error boundary, which explains what to do.
window.addEventListener('vite:preloadError', event => {
  const key = 'graphinity:reloaded-at';
  let last = 0;
  try { last = Number(sessionStorage.getItem(key)) || 0; } catch {}
  if (Date.now() - last < 10_000) return;
  event.preventDefault();
  try { sessionStorage.setItem(key, String(Date.now())); } catch {}
  location.reload();
});

// iOS Safari only applies :active styles when a touch listener exists, and
// press feedback must appear on touch-down.
document.addEventListener('touchstart', () => {}, { passive: true });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
