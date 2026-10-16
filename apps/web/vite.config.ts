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
  const apiOrigin = env.VITE_API_ORIGIN || 'http://localhost:3000';
  // Cloudflare Pages sets CF_PAGES during its builds; a deployed site must
  // never talk to an API over plain http.
  if (process.env.CF_PAGES && !apiOrigin.startsWith('https://')) {
    throw new Error('VITE_API_ORIGIN must be an https origin for a Cloudflare Pages build');
  }
  const headerOptions: HeaderOptions = { connectSrc: [apiOrigin] };

  return {
    plugins: [react(), securityHeadersPlugin(headerOptions)],
    build: {
      target: 'es2022',
      // Every browser we support handles module preloading natively.
      modulePreload: { polyfill: false },
    },
    // `npm run preview` serves the production build with the production headers.
    preview: { port: 4173, strictPort: true, headers: securityHeaders(headerOptions) },
    server: { port: 5173, strictPort: true },
  };
});
