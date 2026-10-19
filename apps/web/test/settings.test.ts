import { describe, expect, it } from 'vitest';
import { parseSettings, settingsFromEnv, settingsProblems, type SiteSettings } from '../src/lib/settings.ts';

const deployed: SiteSettings = {
  apiOrigin: 'https://graphinity-api.onrender.com',
  siteOrigin: 'https://graphinity.pages.dev',
  supabaseUrl: 'https://abcd.supabase.co',
  supabasePublishableKey: 'sb_publishable_0123456789',
  googleClientId: '123-abc.apps.googleusercontent.com',
  googleAuthorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
};

describe('reading the settings a deploy wrote', () => {
  it('takes all six, and nothing else', () => {
    expect(parseSettings(JSON.stringify({ ...deployed, extra: 'ignored' }))).toEqual(deployed);
  });

  it('refuses a page that was never stamped, or anything not the right shape', () => {
    expect(parseSettings('%GRAPHINITY_SETTINGS%')).toBeNull();
    expect(parseSettings(null)).toBeNull();
    expect(parseSettings('[]')).toBeNull();
    const { googleClientId: _, ...missing } = deployed;
    expect(parseSettings(JSON.stringify(missing))).toBeNull();
    expect(parseSettings(JSON.stringify({ ...deployed, apiOrigin: 42 }))).toBeNull();
    expect(parseSettings(JSON.stringify({ ...deployed, apiOrigin: '' }))).toBeNull();
  });
});

describe('checking settings before they are written', () => {
  it('accepts a proper deployment', () => {
    expect(settingsProblems(deployed, true)).toEqual([]);
  });

  it('refuses plain http, paths, the wrong key or the stand-in sign-in once deployed', () => {
    expect(settingsProblems({ ...deployed, apiOrigin: 'http://graphinity-api.onrender.com' }, true)).toEqual(['apiOrigin must use https when deployed']);
    expect(settingsProblems({ ...deployed, siteOrigin: 'https://graphinity.pages.dev/app' }, true)[0]).toMatch(/siteOrigin must be an origin/);
    expect(settingsProblems({ ...deployed, supabasePublishableKey: 'sb_secret_0123' }, true)[0]).toMatch(/publishable/);
    expect(settingsProblems({ ...deployed, googleAuthorizeUrl: 'http://localhost:54321/o/oauth2/v2/auth' }, true)[0]).toMatch(/googleAuthorizeUrl/);
    expect(settingsProblems({ ...deployed, googleClientId: 'not-google' }, true)[0]).toMatch(/googleClientId/);
  });

  it('falls back to this computer only when local, and to nothing when deployed', () => {
    const local = settingsFromEnv({}, true);
    expect(local).toMatchObject({ apiOrigin: 'http://localhost:3000', supabaseUrl: 'http://localhost:54321', googleAuthorizeUrl: 'http://localhost:54321/o/oauth2/v2/auth' });
    expect(settingsProblems(local, false)).toEqual([]);
    const unset = settingsFromEnv({}, false);
    expect(unset.apiOrigin).toBe('');
    expect(settingsProblems(unset, true).length).toBeGreaterThanOrEqual(4);
  });

  it('uses Google itself for a real Supabase project, even locally', () => {
    const s = settingsFromEnv({ VITE_SUPABASE_URL: 'https://abcd.supabase.co', VITE_GOOGLE_CLIENT_ID: deployed.googleClientId }, true);
    expect(s.googleAuthorizeUrl).toBe(deployed.googleAuthorizeUrl);
  });
});
