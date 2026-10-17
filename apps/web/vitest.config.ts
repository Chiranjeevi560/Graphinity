import { defineConfig } from 'vitest/config';

// Unit tests only. Browser tests in e2e/ belong to Playwright (npm run test:e2e).
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
  },
});
