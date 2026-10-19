// This page's settings, read once from the meta tag the deploy wrote
// (lib/settings.ts). A copy that was never stamped stops here with a plain
// reason, rather than quietly calling a server it wasn't meant for.
import { parseSettings, type SiteSettings } from './lib/settings.ts';

function read(): SiteSettings {
  const settings = parseSettings(document.querySelector('meta[name="graphinity-settings"]')?.getAttribute('content'));
  if (!settings) throw new Error('This copy of Graphinity has no settings: its index.html was never stamped for an environment (apps/web/stamp.ts).');
  return settings;
}

export const site: SiteSettings = read();
