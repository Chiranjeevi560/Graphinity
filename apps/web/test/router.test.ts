import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A browser's history, enough for the router: entries with state, and Back.
function fakeBrowser(start = '/') {
  const entries: Array<{ state: unknown; path: string }> = [{ state: null, path: start }];
  let at = 0;
  const location = { get pathname() { return entries[at]?.path ?? '/'; } };
  const history = {
    get state() { return entries[at]?.state ?? null; },
    pushState(state: unknown, _: string, path: string) { entries.splice(at + 1); entries.push({ state, path }); at += 1; },
    replaceState(state: unknown, _: string, path: string) { entries[at] = { state, path }; },
  };
  const listeners: Array<() => void> = [];
  const window = {
    scrollTo: vi.fn(),
    addEventListener: (_: string, l: () => void) => { listeners.push(l); },
  };
  const back = () => { at -= 1; listeners.forEach(l => { l(); }); };
  return { location, history, window, back, get entries() { return entries; } };
}

let browser: ReturnType<typeof fakeBrowser>;
beforeEach(() => {
  vi.resetModules();
  browser = fakeBrowser();
  vi.stubGlobal('window', browser.window);
  vi.stubGlobal('history', browser.history);
  vi.stubGlobal('location', browser.location);
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('Back stays inside Graphinity only when there is somewhere to go', () => {
  it('can’t go back on the page someone arrived at, and can after moving on', async () => {
    const { canGoBack, navigate } = await import('../src/lib/router.ts');
    expect(canGoBack()).toBe(false);
    navigate('/ask');
    expect(canGoBack()).toBe(true);
    expect(browser.location.pathname).toBe('/ask');
    expect(browser.window.scrollTo).toHaveBeenCalledWith(0, 0);
    browser.back();
    expect(canGoBack()).toBe(false);
  });

  it('replacing a page keeps how deep they are, so Back still works after it', async () => {
    const { canGoBack, navigate } = await import('../src/lib/router.ts');
    navigate('/ask');
    navigate('/q/1/title', { replace: true });
    expect(canGoBack()).toBe(true);
    expect(browser.entries).toHaveLength(2);
  });
});

describe('links', () => {
  const click = (extra: object = {}) => ({ defaultPrevented: false, button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, preventDefault: vi.fn(), ...extra });

  it('move within the app on a plain click, keeping a real address for everything else', async () => {
    const { Link } = await import('../src/lib/router.ts');
    const link = Link({ to: '/ask', children: 'Ask' }) as { props: { href: string; onClick: (e: object) => void } };
    expect(link.props.href).toBe('/ask');
    const plain = click();
    link.props.onClick(plain);
    expect(plain.preventDefault).toHaveBeenCalled();
    expect(browser.location.pathname).toBe('/ask');
  });

  it('leave new-tab, new-window and other-button clicks to the browser', async () => {
    const { Link } = await import('../src/lib/router.ts');
    const link = Link({ to: '/ask' }) as { props: { onClick: (e: object) => void } };
    for (const extra of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }, { defaultPrevented: true }]) {
      const e = click(extra);
      link.props.onClick(e);
      expect(e.preventDefault, JSON.stringify(extra)).not.toHaveBeenCalled();
    }
    expect(browser.location.pathname).toBe('/');
  });

  it('don’t add a history entry for the page already shown', async () => {
    const { Link } = await import('../src/lib/router.ts');
    const link = Link({ to: '/' }) as { props: { onClick: (e: object) => void } };
    link.props.onClick(click());
    expect(browser.entries).toHaveLength(1);
  });
});
