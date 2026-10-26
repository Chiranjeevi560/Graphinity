// The service worker (public/sw.js) runs in a stand-in for the browser: it
// must show only well-formed notifications, and open only Graphinity's own
// question pages or, for a moderator's alert, the operations screen.
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

type Listener = (event: Record<string, unknown>) => void;

function load() {
  const listeners = new Map<string, Listener>();
  const shown: Array<{ title: string; options: { body: string; tag: string; data: { path: string } } }> = [];
  const opened: string[] = [];
  const self = {
    location: { origin: 'https://graphinity.pages.dev' },
    addEventListener: (type: string, fn: Listener) => listeners.set(type, fn),
    registration: {
      showNotification: (title: string, options: (typeof shown)[number]['options']) => {
        shown.push({ title, options });
        return Promise.resolve();
      },
    },
    clients: {
      matchAll: () => Promise.resolve([]),
      openWindow: (url: string) => {
        opened.push(url);
        return Promise.resolve(null);
      },
    },
  };
  runInNewContext(readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8'), { self, URL });
  const waits: Promise<unknown>[] = [];
  const push = (data: unknown) => {
    listeners.get('push')?.({
      data: { json: () => (typeof data === 'string' ? JSON.parse(data) : data) as unknown },
      waitUntil: (p: Promise<unknown>) => waits.push(p),
    });
    return Promise.all(waits);
  };
  const click = (path: unknown) => {
    listeners.get('notificationclick')?.({
      notification: { close: () => undefined, data: { path } },
      waitUntil: (p: Promise<unknown>) => waits.push(p),
    });
    return Promise.all(waits);
  };
  return { shown, opened, push, click };
}

describe('the service worker', () => {
  it('shows a question notification that opens the question', async () => {
    const sw = load();
    await sw.push({ title: 'New answer to your question', body: 'Is the old town walkable?', questionId: '42' });
    expect(sw.shown).toEqual([
      {
        title: 'New answer to your question',
        options: expect.objectContaining({ body: 'Is the old town walkable?', data: { path: '/q/42' } }) as unknown,
      },
    ]);
    await sw.click('/q/42');
    expect(sw.opened).toEqual(['https://graphinity.pages.dev/q/42']);
  });

  it('shows a moderator’s alert that opens the operations screen, one per problem', async () => {
    const sw = load();
    await sw.push({
      kind: 'ops',
      key: 'job:routing',
      title: 'Sending questions to people isn’t working',
      body: 'Its last run failed.',
    });
    expect(sw.shown[0]?.options).toMatchObject({ tag: 'ops:job:routing', data: { path: '/ops' } });
    await sw.click('/ops');
    expect(sw.opened).toEqual(['https://graphinity.pages.dev/ops']);
  });

  it('ignores anything malformed, and never opens a page that isn’t its own', async () => {
    const sw = load();
    await sw.push(null);
    await sw.push({ title: 'x', body: 'y', questionId: '../admin' });
    await sw.push({ kind: 'ops', key: 'javascript:alert(1)', title: 'x', body: 'y' });
    await sw.push({ kind: 'ops', title: 'x', body: 'y' });
    expect(sw.shown).toEqual([]);
    await sw.click('https://evil.example/');
    await sw.click('/ops/../../evil');
    await sw.click('//evil.example');
    expect(sw.opened).toEqual([]);
  });
});
