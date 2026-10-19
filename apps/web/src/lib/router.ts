// A deliberately small router: the app has a handful of screens and every
// dependency is something to audit.
import { createElement, useSyncExternalStore, type AnchorHTMLAttributes, type MouseEvent } from 'react';

const listeners = new Set<() => void>();
const notify = () => {
  listeners.forEach(l => {
    l();
  });
};

if (typeof window !== 'undefined') window.addEventListener('popstate', notify);

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// How many screens deep the person is inside the app, kept in the history
// entry itself so Back and Forward carry it. 0: they arrived here directly.
const depth = (): number => (history.state as { depth?: number } | null)?.depth ?? 0;

/** True when going back stays inside Graphinity. */
export function canGoBack(): boolean {
  return depth() > 0;
}

export function navigate(to: string, { replace = false } = {}) {
  if (replace) history.replaceState({ depth: depth() }, '', to);
  else history.pushState({ depth: depth() + 1 }, '', to);
  window.scrollTo(0, 0);
  notify();
}

export function usePath(): string {
  return useSyncExternalStore(
    subscribe,
    () => location.pathname,
    () => '/',
  );
}

interface LinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  to: string;
}

export function Link({ to, onClick, ...rest }: LinkProps) {
  const handle = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    // Let the browser handle new-tab, new-window and non-primary clicks.
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    if (to !== location.pathname) navigate(to);
  };
  return createElement('a', { href: to, onClick: handle, ...rest });
}
