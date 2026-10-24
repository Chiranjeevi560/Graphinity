import { defineConfig } from 'vitest/config';

// Unit tests only. Browser tests in e2e/ belong to Playwright (npm run test:e2e).
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Unit coverage is for non-visual logic. Browser tests in apps/web/e2e
    // exercise rendered React screens across Chromium and WebKit; Vitest has
    // no DOM environment and should not count those UI files as uncovered.
    coverage: {
      thresholds: { lines: 47.27 },
      exclude: ['src/**/*.tsx'],
    },
  },
});
