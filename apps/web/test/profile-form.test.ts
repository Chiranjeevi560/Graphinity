import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The module signs requests through the app's one session, which reads the
// page's address when it loads.
beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal('location', { origin: 'https://graphinity.pages.dev', assign: vi.fn() });
});
afterEach(() => { vi.unstubAllGlobals(); });

const meta = { fields: [{ slug: 'travel', name: 'Travel' }], countries: [{ code: 'IN', name: 'India' }] };

describe('the list of topics and countries', () => {
  it('is fetched once and shared by every screen that needs it', async () => {
    const fetch = vi.fn(() => Promise.resolve(Response.json(meta)));
    vi.stubGlobal('fetch', fetch);
    const { loadMeta } = await import('../src/routes/profile-form.ts');
    expect(await Promise.all([loadMeta(), loadMeta()])).toEqual([meta, meta]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('is fetched again after a failure, instead of failing for the rest of the visit', async () => {
    const fetch = vi.fn()
      .mockImplementationOnce(() => Promise.reject(new TypeError('Failed to fetch')))
      .mockImplementationOnce(() => Promise.resolve(Response.json(meta)));
    vi.stubGlobal('fetch', fetch);
    const { loadMeta } = await import('../src/routes/profile-form.ts');
    await expect(loadMeta()).rejects.toThrow();
    expect(await loadMeta()).toEqual(meta);
  });
});

describe('guessing the country', () => {
  it('uses the region in the browser’s language, only if it is one we know', async () => {
    const { guessCountry } = await import('../src/routes/profile-form.ts');
    vi.stubGlobal('navigator', { language: 'en-IN' });
    expect(guessCountry(['IN', 'GB'])).toBe('IN');
    vi.stubGlobal('navigator', { language: 'en-ZZ' });
    expect(guessCountry(['IN', 'GB'])).toBe('');
    vi.stubGlobal('navigator', { language: 'not a language tag!' });
    expect(guessCountry(['IN'])).toBe('');
  });
});
