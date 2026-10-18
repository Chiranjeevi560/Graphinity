// What search engines and the browser tab see for each screen. The page is
// one HTML file, so title, canonical address and indexing are set as people
// move between screens. Google renders the app and reads these.

export interface PageMeta {
  title: string;
  /** Only screens meant to be found in search are indexed. */
  index: boolean;
}

const SITE = 'Graphinity';
const HOME_TITLE = 'Graphinity: ask people who’ve actually done it';

export function pageMeta(path: string): PageMeta {
  if (path === '/') return { title: HOME_TITLE, index: true };
  const profile = /^\/u\/([^/]+)$/.exec(path)?.[1];
  // Profiles stay out of search until the owner decides they should be found.
  if (profile) return { title: `@${safeDecode(profile)} – ${SITE}`, index: false };
  const titles: Record<string, string> = {
    '/welcome': 'Set up your profile',
    '/me': 'Your profile',
    '/me/edit': 'Edit profile',
    '/goodbye': 'Account deleted',
    '/auth/callback': 'Signing in',
    '/design': 'Design',
  };
  return { title: `${titles[path] ?? 'Page not found'} – ${SITE}`, index: false };
}

export function applyMeta(meta: PageMeta, path: string, siteOrigin: string): void {
  document.title = meta.title;
  document.querySelector('meta[name="robots"]')?.setAttribute('content', meta.index ? 'index, follow, max-image-preview:large' : 'noindex');
  document.querySelector('link[rel="canonical"]')?.setAttribute('href', new URL(path, siteOrigin).toString());
}

function safeDecode(part: string): string {
  try { return decodeURIComponent(part); } catch { return part; }
}
