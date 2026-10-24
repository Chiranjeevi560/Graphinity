import { existsSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

// Written by `npm run db:start`. CI sets the variable directly instead.
const testEnv = new URL('../../.local/test.env', import.meta.url);
if (existsSync(testEnv)) process.loadEnvFile(testEnv);

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Integration tests each create their own database; keep runs predictable.
    fileParallelism: false,
    // The coverage ratchet in CONSTRAINTS.md: today's numbers less its 0.5
    // point tolerance. Applies whenever coverage is measured (test:coverage).
    coverage: {
      thresholds: { lines: 89.86, branches: 85.65 },
      // Process entrypoints are exercised by the production image health gate;
      // importing them in Vitest would start listeners and background timers.
      exclude: ['src/main.ts', 'src/migrate-main.ts'],
    },
  },
});
