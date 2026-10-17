import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import { assertNoInlineScripts, pagesHeadersFile, securityHeaders, type HeaderOptions } from './headers.ts';

function securityHeadersPlugin(options: HeaderOptions): Plugin {
  return {
    name: 'graphinity-security-headers',
    apply: 'build',
    generateBundle(_, bundle) {
      const html = bundle['index.html'];
      if (html?.type === 'asset') assertNoInlineScripts(String(html.source));
      this.emitFile({ type: 'asset', fileName: '_headers', source: pagesHeadersFile(options) });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  // Defaults point at the local API and the local sign-in stand-in
  // (npm run dev:api, npm run dev:auth).
  const apiOrigin = env.VITE_API_ORIGIN || 'http://localhost:3000';
  const supabaseUrl = env.VITE_SUPABASE_URL || 'http://localhost:54321';
  const supabaseKey = env.VITE_SUPABASE_PUBLISHABLE_KEY || 'dev_publishable_key';
  // Cloudflare Pages sets CF_PAGES during its builds; a deployed site must
  // never talk to plain http, nor fall back to the local stand-ins.
  if (process.env.CF_PAGES) {
    for (const [name, value] of [['VITE_API_ORIGIN', env.VITE_API_ORIGIN], ['VITE_SUPABASE_URL', env.VITE_SUPABASE_URL]]) {
      if (!value?.startsWith('https://')) throw new Error(`${name} must be an https origin for a Cloudflare Pages build`);
    }
    if (!env.VITE_SUPABASE_PUBLISHABLE_KEY?.startsWith('sb_publishable_')) {
      throw new Error('VITE_SUPABASE_PUBLISHABLE_KEY must be the project\'s publishable key (sb_publishable_...)');
    }
  }
  const headerOptions: HeaderOptions = { connectSrc: [apiOrigin, supabaseUrl] };

  return {
    plugins: [react(), securityHeadersPlugin(headerOptions)],
    define: {
      'import.meta.env.VITE_API_ORIGIN': JSON.stringify(apiOrigin),
      'import.meta.env.VITE_SUPABASE_URL': JSON.stringify(supabaseUrl),
      'import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY': JSON.stringify(supabaseKey),
    },
    build: {
      target: 'es2022',
      // Every browser we support handles module preloading natively.
      modulePreload: { polyfill: false },
    },
    // `npm run preview` serves the production build with the production headers.
    preview: { port: 4173, strictPort: true, headers: securityHeaders({ ...headerOptions, localHttp: true }) },
    server: { port: 5173, strictPort: true },
  };
});
