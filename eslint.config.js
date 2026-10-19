// Lint rules for the whole repository. Type-aware: rules can see TypeScript
// types, so they catch things like an unhandled promise, not just style.
import js from '@eslint/js';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/dist-local/**',
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
  // The keep-awake Cloudflare Worker (module syntax, Workers runtime).
  { files: ['workers/**/*.js', 'functions/**/*.ts'], languageOptions: { globals: globals.serviceworker } },

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
);
