// Lint rules for the whole repository. Type-aware: rules can see TypeScript
// types, so they catch things like an unhandled promise, not just style.
import js from '@eslint/js';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// The ranking firewall (ADR 0025): what decides knowledge, trust, reputation and
// personalization can't even import advertising or commerce, so money can't
// reach them by accident. test/invariants proves the same thing by perturbing bids.
const firewalled = {
  files: [
    'apps/api/src/search/**',
    'apps/api/src/recommendations/**',
    'apps/api/src/personalization/**',
    'apps/api/src/kg/**',
    'apps/api/src/routing*.ts',
    'apps/api/src/reputation.ts',
    'apps/api/src/consensus.ts',
    'apps/api/src/collusion.ts',
    'apps/api/src/ml/collusion.ts',
    'apps/api/src/precheck.ts',
  ],
  rules: {
    'no-restricted-imports': [
      'error',
      {
        patterns: [
          {
            group: ['**/ads/**', '**/commerce/**', '**/commercial-intent.ts', '**/routes/ad*'],
            message: 'The ranking firewall: knowledge, trust, reputation and personalization take no commercial input.',
          },
        ],
      },
    ],
  },
};

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/dist-local/**',
      '**/dist-pages/**',
      '**/node_modules/**',
      '.local/**',
      '**/coverage/**',
      'test-results/**',
      'playwright-report/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // Numbers in template strings are fine; objects and undefined are not.
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      // A leading underscore marks a deliberately unused value.
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },

  // Plain JavaScript (configs, scripts): no type information.
  {
    files: ['**/*.js', '**/*.mjs', '**/vitest.config.ts', '**/vite.config.ts', '**/playwright.config.ts'],
    ...tseslint.configs.disableTypeChecked,
  },
  { files: ['scripts/**', '*.config.*', 'apps/*/*.config.*'], languageOptions: { globals: globals.node } },
  // The notification worker runs in the browser as a service worker.
  { files: ['apps/web/public/sw.js'], languageOptions: { globals: globals.serviceworker } },
  { files: ['apps/web/public/ads/tag.js'], languageOptions: { globals: globals.browser } },
  // The keep-awake Cloudflare Worker (module syntax, Workers runtime).
  { files: ['workers/**/*.js', 'apps/web/functions/**/*.ts'], languageOptions: { globals: globals.serviceworker } },

  // The website: browser globals, React hooks rules, accessibility rules.
  {
    files: ['apps/web/src/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks, 'jsx-a11y': jsxA11y },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...jsxA11y.flatConfigs.strict.rules,
    },
  },

  // The server and its tests run on Node.
  {
    files: ['apps/api/**/*.ts', 'apps/web/test/**', 'apps/web/e2e/**', 'apps/web/*.ts'],
    languageOptions: { globals: globals.node },
  },
  firewalled,
);
