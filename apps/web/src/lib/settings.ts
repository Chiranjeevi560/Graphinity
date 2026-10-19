// Where this copy of the site talks to: its API, its sign-in, its own address.
// Not compiled in: the same build runs in staging and then production, and
// each deploy writes its own values into index.html (stamp.ts,
// docs/adr/0002-environments.md). Public values only: nothing here is secret.

export interface SiteSettings {
  apiOrigin: string;
  siteOrigin: string;
  supabaseUrl: string;
  supabasePublishableKey: string;
  googleClientId: string;
  googleAuthorizeUrl: string;
}

export const SETTING_KEYS = ['apiOrigin', 'siteOrigin', 'supabaseUrl', 'supabasePublishableKey', 'googleClientId', 'googleAuthorizeUrl'] as const satisfies ReadonlyArray<keyof SiteSettings>;

const GOOGLE_AUTHORIZE = 'https://accounts.google.com/o/oauth2/v2/auth';

/** The settings in a page's meta tag, or null when they're missing or not the right shape. */
export function parseSettings(raw: string | null | undefined): SiteSettings | null {
  if (!raw) return null;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  const out: Partial<SiteSettings> = {};
  for (const k of SETTING_KEYS) {
    const s = v[k];
    if (typeof s !== 'string' || s === '') return null;
    out[k] = s;
  }
  return out as SiteSettings;
}

/** Plain-words problems with a set of settings; empty when they're fine. Never echoes values beyond names. */
export function settingsProblems(s: SiteSettings, deployed: boolean): string[] {
  const problems: string[] = [];
  for (const k of ['apiOrigin', 'siteOrigin', 'supabaseUrl'] as const) {
    if (!isOrigin(s[k])) problems.push(`${k} must be an origin like https://example.com (no path)`);
    else if (deployed && !s[k].startsWith('https://')) problems.push(`${k} must use https when deployed`);
  }
  if (deployed && !s.supabasePublishableKey.startsWith('sb_publishable_')) problems.push('supabasePublishableKey must be the project\'s publishable key (sb_publishable_...)');
  if (!s.googleClientId.endsWith('.apps.googleusercontent.com')) problems.push('googleClientId must be a Google OAuth client ID (...apps.googleusercontent.com)');
  // Deployed, sign-in goes to Google itself; only the local stand-in plays Google.
  if (deployed && s.googleAuthorizeUrl !== GOOGLE_AUTHORIZE) problems.push(`googleAuthorizeUrl must be ${GOOGLE_AUTHORIZE} when deployed`);
  return problems;
}

/**
 * Settings from VITE_* variables (the names the Pages project and .env files
 * use). Locally, anything unset falls back to this computer's servers and the
 * sign-in stand-in; deployed, nothing falls back.
 */
export function settingsFromEnv(env: Record<string, string | undefined>, local: boolean): SiteSettings {
  const fallback = (v: string | undefined, dev: string) => v || (local ? dev : '');
  const supabaseUrl = fallback(env.VITE_SUPABASE_URL, 'http://localhost:54321');
  const standIn = local && supabaseUrl.startsWith('http://localhost:');
  return {
    apiOrigin: fallback(env.VITE_API_ORIGIN, 'http://localhost:3000'),
    siteOrigin: fallback(env.VITE_SITE_ORIGIN, 'http://localhost:4173'),
    supabaseUrl,
    supabasePublishableKey: fallback(env.VITE_SUPABASE_PUBLISHABLE_KEY, 'dev_publishable_key'),
    googleClientId: env.VITE_GOOGLE_CLIENT_ID || (standIn ? 'dev-client.apps.googleusercontent.com' : ''),
    googleAuthorizeUrl: standIn ? `${supabaseUrl}/o/oauth2/v2/auth` : GOOGLE_AUTHORIZE,
  };
}

function isOrigin(value: string): boolean {
  try {
    const u = new URL(value);
    return (u.protocol === 'https:' || u.protocol === 'http:') && u.origin === value;
  } catch {
    return false;
  }
}
