// The browser tests' own database, separate from the development one: made
// fresh for every run (scripts/e2e-api.mjs), so data left by earlier runs
// can't change what a test sees. Leftover questions made tests flaky
// (a duplicate offer greyed out Post), and test runs filled the local
// database people develop against.
import { readFileSync } from 'node:fs';

export const E2E_DATABASE = 'graphinity_e2e';

/** An administrator's connection: CI's ADMIN_URL, or the local one `npm run db:start` writes. */
export function adminUrl(): string {
  const fromEnv = process.env.ADMIN_URL;
  if (fromEnv) return fromEnv;
  let env = '';
  try {
    env = readFileSync('.local/test.env', 'utf8');
  } catch {
    /* reported below */
  }
  const local = /^TEST_DATABASE_ADMIN_URL=(.+)$/m.exec(env)?.[1];
  if (!local) throw new Error('No admin URL: set ADMIN_URL or run npm run db:start');
  return local;
}

/** A connection to the tests' database, as the administrator or as another role. */
export function e2eUrl(user?: { name: string; password: string }): string {
  const url = new URL(adminUrl());
  url.pathname = `/${E2E_DATABASE}`;
  if (user) {
    url.searchParams.set('user', user.name);
    url.searchParams.set('password', user.password);
    // A socket path (local) or host (CI) in the admin URL stays as it is.
    url.username = '';
    url.password = '';
  }
  return url.toString();
}
