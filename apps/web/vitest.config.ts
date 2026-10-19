import { defineConfig } from 'vitest/config';

// Unit tests only. Browser tests in e2e/ belong to Playwright (npm run test:e2e).
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // The coverage ratchet in CONSTRAINTS.md: today's number less its 0.5
    // point tolerance. Applies whenever coverage is measured (test:coverage).
    coverage: { thresholds: { lines: 47.27 } },
  },
});
