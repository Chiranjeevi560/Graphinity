// Browser tests across the three engines people actually use: Chromium
// (Chrome, Edge, Android), WebKit (Safari, every browser on iPhone) and
// Firefox. They run against the production build served with the production
// security headers, the real API and the local sign-in stand-in.
import { createECDH } from 'node:crypto';
import { defineConfig, devices } from '@playwright/test';
import { privateKeyText } from './apps/api/src/push.ts';

// A throwaway secret shared by the API and the stand-in during tests, so the
// real Supabase secret in .local/api.env is never sent anywhere but Supabase.
const TEST_SECRET = 'test_secret_playwright_only_0123456789';

// A web push key pair made fresh for each run, so the notifications setting
// shows (nothing is actually sent: that would need Google's push service).
const vapid = createECDH('prime256v1');
vapid.generateKeys();

export default defineConfig({
  testDir: 'apps/web/e2e',
  outputDir: 'test-results',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  // In CI, each failure also becomes an annotation on the run and its pull request, readable by
  // anyone reviewing, without downloading the report.
  reporter: [
    ['list'],
    ['json', { outputFile: 'test-results/results.json' }],
    ...(process.env.CI ? [['github'] as const] : []),
  ],
  timeout: 120_000,
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
  ],
  webServer: [
    {
      command: 'node scripts/dev-auth.mjs',
      url: 'http://localhost:54321/auth/v1/.well-known/jwks.json',
      reuseExistingServer: false,
      env: { DEV_AUTH_SECRET_KEY: TEST_SECRET },
    },
    {
      // A fresh database for every run, then the API on it (scripts/e2e-api.mjs).
      command: 'node scripts/e2e-api.mjs',
      url: 'http://localhost:3000/health',
      reuseExistingServer: false,
      // Variables set here win over the env file.
      env: {
        WEB_ORIGIN: 'http://localhost:4173',
        SUPABASE_URL: 'http://localhost:54321',
        SUPABASE_SECRET_KEY: TEST_SECRET,
        VAPID_PUBLIC_KEY: vapid.getPublicKey().toString('base64url'),
        VAPID_PRIVATE_KEY: privateKeyText(vapid),
      },
    },
    {
      command: 'npm --workspace apps/web run build && npm --workspace apps/web run preview',
      url: 'http://localhost:4173',
      reuseExistingServer: false,
      timeout: 180_000,
    },
  ],
});
