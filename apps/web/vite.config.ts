import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import { assertNoInlineScripts, securityHeaders } from './headers.ts';
import { settingsFromEnv, settingsProblems } from './src/lib/settings.ts';
import { stampIndexHtml } from './stamp.ts';

// The build names no environment: no API address, sign-in or site address
// is compiled in, so the same files go to staging and then production. Each
// deploy writes its settings into a copy (stamp.ts, docs/adr/0002). Here,
// only the dev server stamps, with this computer's settings.

function buildChecksPlugin(): Plugin {
  return {
    name: 'graphinity-build-checks',
    apply: 'build',
    generateBundle(_, bundle) {
      const html = bundle['index.html'];
      if (html?.type === 'asset') assertNoInlineScripts(String(html.source));
      // Only these paths run the host's Functions (/functions); everything
      // else is a free static file. If the free daily allowance runs out,
      // "fail open" in Cloudflare serves the static page instead.
      this.emitFile({ type: 'asset', fileName: '_routes.json', source: JSON.stringify({ version: 1, include: ['/q/*', '/sitemap.xml'], exclude: [] }) });
    },
  };
}

export default defineConfig(({ mode, command }) => {
  // Locally: .env files for a mode (e.g. --mode supabase), else this
  // computer's servers and the sign-in stand-in.
  const local = settingsFromEnv(loadEnv(mode, process.cwd(), 'VITE_'), true);
  if (command === 'serve') {
    const problems = settingsProblems(local, false);
    if (problems.length) throw new Error(`Local settings: ${problems.join('; ')}`);
  }
  const devStamp: Plugin = { name: 'graphinity-dev-settings', apply: 'serve', transformIndexHtml: html => stampIndexHtml(html, local) };

  return {
    plugins: [react(), buildChecksPlugin(), devStamp],
    build: {
      target: 'es2022',
      // Every browser we support handles module preloading natively.
      modulePreload: { polyfill: false },
    },
    // `npm run preview` serves a stamped copy (dist-local) with the production headers.
    preview: { port: 4173, strictPort: true, headers: securityHeaders({ connectSrc: [local.apiOrigin, local.supabaseUrl], localHttp: true }) },
    server: { port: 5173, strictPort: true },
  };
});
