import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type Api } from '../src/lib/api.ts';
import { isPushOn, pushSupport, turnPushOff, turnPushOn } from '../src/lib/push.ts';

// A browser with push: one service worker, subscriptions that remember
// whether they were cancelled.
interface FakeSubscription {
  endpoint: string;
  cancelled: boolean;
  toJSON(): object;
  unsubscribe(): Promise<boolean>;
}
let current: FakeSubscription | null = null;
let made = 0;

function subscription(): FakeSubscription {
  made += 1;
  const sub: FakeSubscription = {
    endpoint: `https://fcm.googleapis.com/fcm/send/${String(made)}`,
    cancelled: false,
    toJSON: () => ({ endpoint: sub.endpoint, keys: { p256dh: 'p', auth: 'a' } }),
    unsubscribe: () => {
      sub.cancelled = true;
      current = null;
      return Promise.resolve(true);
    },
  };
  return sub;
}

beforeEach(() => {
  current = null;
  made = 0;
  const pushManager = {
    subscribe: () => Promise.resolve((current ??= subscription())),
    getSubscription: () => Promise.resolve(current),
  };
  const registration = { pushManager };
  // Only presence is checked, so any value stands in for the constructors.
  vi.stubGlobal('window', { PushManager: {}, Notification: {} });
  vi.stubGlobal('Notification', { permission: 'granted', requestPermission: () => Promise.resolve('granted') });
  vi.stubGlobal('navigator', {
    userAgent: 'test',
    platform: 'test',
    maxTouchPoints: 0,
    serviceWorker: {
      register: () => Promise.resolve(registration),
      ready: Promise.resolve(registration),
      getRegistration: () => Promise.resolve(registration),
    },
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

/** An API that answers each call in turn and records what was asked. */
function fakeApi(...answers: Array<() => unknown>) {
  const calls: Array<{ path: string; method: string | undefined }> = [];
  // Async, so an answer that throws becomes a rejected request, like the real one.
  const api = (async (path: string, options: { method?: string } = {}) => {
    calls.push({ path, method: options.method });
    const next = answers.shift();
    if (!next) throw new Error(`no answer for ${path}`);
    await Promise.resolve();
    return next();
  }) as unknown as Api;
  return { api, calls };
}

const refuse = (status: number, code: string) => () => {
  throw new ApiError(status, code, code);
};

describe('turning notifications on', () => {
  it('cancels the browser’s subscription when the server didn’t save it', async () => {
    const { api } = fakeApi(refuse(409, 'too_many_devices'));
    await expect(turnPushOn(api, 'AQAB')).rejects.toThrow('too_many_devices');
    expect(current).toBeNull();
    expect(made).toBe(1);
  });

  it('cancels the fresh subscription too when the retry for a shared device fails', async () => {
    const { api } = fakeApi(refuse(409, 'device_in_use'), refuse(503, 'unavailable'));
    await expect(turnPushOn(api, 'AQAB')).rejects.toThrow('unavailable');
    expect(made).toBe(2);
    expect(current).toBeNull();
  });

  it('keeps the subscription once saved', async () => {
    const { api } = fakeApi(() => ({ push: { on: true } }));
    expect(await turnPushOn(api, 'AQAB')).toBe('on');
    expect(current?.cancelled).toBe(false);
  });
});

describe('whether notifications are on', () => {
  it('asks the server, because the browser’s subscription may be another account’s', async () => {
    current = subscription();
    const { api, calls } = fakeApi(() => ({ push: { on: false } }));
    expect(await isPushOn(api)).toBe(false);
    expect(calls).toEqual([{ path: '/me/push/status', method: 'POST' }]);
  });

  it('is on when the server says this device is theirs', async () => {
    current = subscription();
    const { api } = fakeApi(() => ({ push: { on: true } }));
    expect(await isPushOn(api)).toBe(true);
  });

  it('is off without asking when the browser has no subscription', async () => {
    const { api, calls } = fakeApi();
    expect(await isPushOn(api)).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe('turning notifications off', () => {
  it('removes the device from the server and cancels it in the browser, even if the server can’t be reached', async () => {
    current = subscription();
    const sub = current;
    const { api, calls } = fakeApi(refuse(503, 'unavailable'));
    await turnPushOff(api);
    expect(calls).toEqual([{ path: '/me/push', method: 'DELETE' }]);
    expect(sub.cancelled).toBe(true);
  });

  it('does nothing when already off', async () => {
    const { api, calls } = fakeApi();
    await turnPushOff(api);
    expect(calls).toEqual([]);
  });
});

describe('where notifications are possible', () => {
  it('tells iPhone visitors to add the site to the Home Screen first', () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)',
      platform: 'iPhone',
      maxTouchPoints: 5,
    });
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    expect(pushSupport()).toBe('install-first');
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (X11; Linux x86_64)', platform: 'Linux', maxTouchPoints: 0 });
    expect(pushSupport()).toBe('unsupported');
  });
});
