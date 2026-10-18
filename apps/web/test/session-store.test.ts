import { describe, expect, it } from 'vitest';
import { ApiError, type Api } from '../src/lib/api.ts';
import type { Auth } from '../src/lib/auth.ts';
import { createSessionStore, type Profile } from '../src/lib/session-store.ts';

const profile: Profile = { handle: 'chiru', country: { code: 'IN', name: 'India' }, fields: [], joined: '2026-10' };

/** A /me endpoint whose answers the test releases one at a time. */
interface MeAnswer { profile: Profile | null; moderator?: boolean; blocked?: boolean }

function controllableMe() {
  const pending: Array<(value: MeAnswer) => void> = [];
  const api = ((path: string) => {
    if (path !== '/me') throw new Error(`unexpected ${path}`);
    return new Promise(resolve => { pending.push(resolve); });
  }) as unknown as Api;
  return { api, answer: (i: number, value: MeAnswer) => { pending[i]?.(value); }, count: () => pending.length };
}

function fakeAuth(initial: boolean) {
  let session = initial;
  const listeners = new Set<() => void>();
  const auth = {
    hasSession: () => session,
    subscribe: (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; },
  } as unknown as Auth;
  return { auth, signOut: () => { session = false; listeners.forEach(l => { l(); }); } };
}

const flush = () => new Promise(r => setTimeout(r, 0));

describe('createSessionStore', () => {
  it('a slower, older answer never overwrites a newer state', async () => {
    const me = controllableMe();
    const a = fakeAuth(true);
    const store = createSessionStore({ auth: a.auth, api: me.api });
    void store.reload();           // reload #1 asks /me, still waiting
    a.signOut();                   // signing out triggers reload #2: signed out at once
    await flush();
    expect(store.getState()).toEqual({ status: 'signedOut' });
    me.answer(0, { profile });     // the old /me answer arrives late
    await flush();
    expect(store.getState()).toEqual({ status: 'signedOut' });
  });

  it('shows "offline" rather than "signed out" when the network is down', async () => {
    const api = (() => Promise.reject(new ApiError(0, 'offline', 'You seem to be offline. Check your connection and try again.'))) as unknown as Api;
    const store = createSessionStore({ auth: fakeAuth(true).auth, api });
    await store.reload();
    expect(store.getState()).toEqual({ status: 'unreachable', message: 'You seem to be offline. Check your connection and try again.' });
  });

  it('reports ready or needs-profile from /me, and signed out without a session', async () => {
    const me = controllableMe();
    const store = createSessionStore({ auth: fakeAuth(true).auth, api: me.api });
    const done = store.reload();
    me.answer(0, { profile: null });
    await done;
    expect(store.getState()).toEqual({ status: 'needsProfile' });
    store.setProfile(profile);
    expect(store.getState()).toEqual({ status: 'ready', profile: { ...profile, moderator: false, blocked: false } });
    const empty = createSessionStore({ auth: fakeAuth(false).auth, api: me.api });
    await empty.reload();
    expect(empty.getState()).toEqual({ status: 'signedOut' });
  });

  it('keeps whether you moderate when you edit your profile', async () => {
    const me = controllableMe();
    const store = createSessionStore({ auth: fakeAuth(true).auth, api: me.api });
    const done = store.reload();
    me.answer(0, { profile, moderator: true, blocked: false });
    await done;
    expect(store.getState()).toEqual({ status: 'ready', profile: { ...profile, moderator: true, blocked: false } });
    store.setProfile({ ...profile, handle: 'renamed' });
    expect(store.getState()).toEqual({ status: 'ready', profile: { ...profile, handle: 'renamed', moderator: true, blocked: false } });
  });
});
