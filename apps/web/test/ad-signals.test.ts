import { describe, expect, it, vi } from 'vitest';
import { browserTopics, joinProductIntent, landingQuery, leaveAllGroups } from '../src/lib/ad-signals.ts';

describe('outside signals in the browser', () => {
  it('read only an ad link’s term', () => {
    expect(landingQuery('?utm_term=mechanical+watch&x=1')).toBe('mechanical watch');
    expect(landingQuery('?q=private')).toBeNull();
    expect(landingQuery(`?utm_term=${'a'.repeat(300)}`)?.length).toBe(200);
  });
  it('treat a browser without the API, or refusing it, as having no topics', async () => {
    expect(await browserTopics({} as Document)).toEqual([]);
    const doc = { browsingTopics: () => Promise.reject(new Error('blocked')) } as unknown as Document;
    expect(await browserTopics(doc)).toEqual([]);
    const yes = { browsingTopics: () => Promise.resolve([{ topic: 57 }]) } as unknown as Document;
    expect(await browserTopics(yes)).toEqual([57]);
  });
  it('join a group only where the API exists and GPC is off, and leave on withdrawal', async () => {
    const join = vi.fn(() => Promise.resolve());
    expect(await joinProductIntent('x', 'https://g.example', {} as Navigator)).toBe(false);
    const nav = { joinAdInterestGroup: join } as unknown as Navigator;
    expect(await joinProductIntent('x', 'https://g.example', nav)).toBe(true);
    expect(
      await joinProductIntent('x', 'https://g.example', {
        joinAdInterestGroup: join,
        globalPrivacyControl: true,
      } as unknown as Navigator),
    ).toBe(false);
    expect(join).toHaveBeenCalledTimes(1);
    const bad = { joinAdInterestGroup: () => Promise.reject(new Error('no')) } as unknown as Navigator;
    expect(await joinProductIntent('x', 'https://g.example', bad)).toBe(false);
    const clear = vi.fn(() => Promise.resolve());
    await leaveAllGroups('https://g.example', { clearOriginJoinedAdInterestGroups: clear } as unknown as Navigator);
    expect(clear).toHaveBeenCalled();
    await leaveAllGroups('https://g.example', {} as Navigator);
  });
});
