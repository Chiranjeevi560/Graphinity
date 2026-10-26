// What every browser test shares: the quality audit run on each screen
// (accessibility in light and dark, sideways scrolling at phone and desktop
// widths, tap target sizes), console-error collection, and the steps people
// take (sign in, set up, sign out). The tests themselves are one file per
// journey beside this one.
//
// Findings are soft assertions: every problem on every screen is reported in
// one run, instead of stopping at the first.
import { randomInt } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { errors, expect, test, type Page } from '@playwright/test';
import { e2eUrl } from './database.ts';

export { expect, test };

export const WIDTHS = [320, 375, 430, 1280];
export const MIN_TARGET = 44;

export interface ScreenReport {
  screen: string;
  axe: Array<{
    scheme: string;
    id: string;
    impact: string | null | undefined;
    nodes: number;
    help: string;
    where: string[];
  }>;
  overflow: number[];
  smallTargets: Array<{ width: number; label: string; w: number; h: number }>;
}

export const reports: ScreenReport[] = [];
export const consoleErrors: string[] = [];

/**
 * Playwright's WebKit screenshots inject a style element, which our CSP
 * refuses (two errors per screenshot pair, on every screen; none without
 * screenshots). Only with AUDIT_SHOTS, only in WebKit, only that message.
 */
export function realErrors(errors: string[], browserName: string): string[] {
  if (!process.env.AUDIT_SHOTS || browserName !== 'webkit') return errors;
  return errors.filter(
    e =>
      !e.endsWith(
        ":: Refused to apply a stylesheet because its hash, its nonce, or 'unsafe-inline' does not appear in the style-src directive of the Content Security Policy.",
      ),
  );
}

// Requests in flight per page, except the live-updates stream, which stays
// open on purpose (so "network idle" never comes once someone signs in).
export const inFlight = new WeakMap<Page, Set<object>>();
export function track(page: Page): Set<object> {
  let pending = inFlight.get(page);
  if (pending) return pending;
  const set = new Set<object>();
  inFlight.set(page, set);
  // Page loads are covered by waitForLoadState (and WebKit never reports the
  // callback page as finished, since the app rewrites its address at once).
  page.on('request', r => {
    if (r.resourceType() !== 'document' && !r.url().endsWith('/events')) set.add(r);
  });
  page.on('requestfinished', r => {
    set.delete(r);
  });
  page.on('requestfailed', r => {
    set.delete(r);
  });
  pending = set;
  return pending;
}

export async function settle(page: Page) {
  const pending = track(page);
  await page.waitForLoadState('load');
  // Quiet for 200 ms: nothing loading but the stream. A request stuck for
  // 10 s fails the audit rather than measuring a half-loaded screen.
  const started = Date.now();
  let quietSince = started;
  while (Date.now() - quietSince < 200) {
    if (pending.size > 0) quietSince = Date.now();
    if (Date.now() - started > 10_000)
      throw new Error(`still loading after 10 s: ${[...pending].map(r => (r as { url(): string }).url()).join(', ')}`);
    await page.waitForTimeout(50);
  }
  // Wait out fades so contrast is measured on final colours. Checked two frames
  // on: an element rendered a moment ago starts its fade only at the next frame,
  // and checking before then measured a "Loading…" line at 5% opacity.
  await page.waitForFunction(
    () =>
      new Promise<boolean>(resolve => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            resolve(document.getAnimations().every(a => a.playState !== 'running'));
          });
        });
      }),
  );
}

/**
 * Axe on final colours. Fades are finished first (the audit judges what a
 * person sees once a screen has appeared, not its first frames), and a run
 * during which any animation was playing is discarded and repeated: a
 * screen re-mounted after settle() returned once started its entrance fade
 * mid-audit, and every element measured at 1.05:1 (answers.spec, Chromium).
 */
async function measuredSettled(page: Page) {
  for (let attempt = 1; ; attempt++) {
    await page.evaluate(() => {
      for (const a of document.getAnimations()) if (a.playState === 'running') a.finish();
    });
    const result = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    const moved = await page.evaluate(() => document.getAnimations().some(a => a.playState === 'running'));
    if (!moved) return result;
    if (attempt === 3) throw new Error('the screen kept animating through three accessibility checks');
    await settle(page);
  }
}

export async function audit(page: Page, screen: string) {
  const report: ScreenReport = { screen, axe: [], overflow: [], smallTargets: [] };
  // From the top, as the screen first appears: part-way down, anything near
  // the top is under the sticky header, which says nothing about the screen.
  await page.evaluate(() => {
    window.scrollTo(0, 0);
  });
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await settle(page);
    const result = await measuredSettled(page);
    for (const v of result.violations) {
      report.axe.push({
        scheme,
        id: v.id,
        impact: v.impact,
        nodes: v.nodes.length,
        help: v.help,
        // Which element, and axe's own one-line reason (it includes the measured ratio).
        where: v.nodes.map(
          n => `${n.target.join(' ')} :: ${(n.failureSummary ?? '').split('\n').slice(1).join(' ').slice(0, 160)}`,
        ),
      });
    }
  }
  await page.emulateMedia({ colorScheme: 'light' });
  const original = page.viewportSize();
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 800 });
    await settle(page);
    const { overflow, small } = await page.evaluate(min => {
      const overflow = document.documentElement.scrollWidth > window.innerWidth;
      const small: Array<{ label: string; w: number; h: number }> = [];
      for (const el of document.querySelectorAll<HTMLElement>(
        'a, button, input, select, textarea, [role="button"], label.checkbox',
      )) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        // Links inside running text are exempt (WCAG 2.5.8 "inline").
        if (el.tagName === 'A' && el.closest('p')) continue;
        // A native checkbox or radio inside a label row: the whole row is the
        // target, so measure the row (it must itself be 44px or more).
        if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
          const row = el.closest('label');
          if (row && row.getBoundingClientRect().height >= min) continue;
        }
        if (Math.min(r.width, r.height) < min) {
          small.push({
            label: (el.getAttribute('aria-label') ?? el.textContent).trim().slice(0, 40),
            w: Math.round(r.width),
            h: Math.round(r.height),
          });
        }
      }
      return { overflow, small };
    }, MIN_TARGET);
    if (overflow) report.overflow.push(width);
    for (const s of small) report.smallTargets.push({ width, ...s });
  }
  // AUDIT_SHOTS=1 saves each screen at phone width in both modes, for looking at by eye.
  if (process.env.AUDIT_SHOTS) {
    await page.setViewportSize({ width: 375, height: 812 });
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await settle(page);
      const name = screen.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
      await page.screenshot({
        path: `test-results/shots/${test.info().project.name}/${name}-${scheme}.png`,
        fullPage: true,
      });
    }
    await page.emulateMedia({ colorScheme: 'light' });
  }
  if (original) await page.setViewportSize(original);
  reports.push(report);
  // Saved after every screen, so a later failure can't hide earlier findings.
  mkdirSync('test-results', { recursive: true });
  writeFileSync(
    `test-results/audit-${test.info().project.name}.json`,
    JSON.stringify({ reports, consoleErrors }, null, 2),
  );

  expect
    .soft(
      report.axe.filter(v => v.impact === 'critical' || v.impact === 'serious'),
      `${screen}: serious accessibility problems`,
    )
    .toEqual([]);
  expect.soft(report.overflow, `${screen}: sideways scrolling at these widths`).toEqual([]);
  expect.soft(report.smallTargets, `${screen}: tap targets under ${MIN_TARGET}px`).toEqual([]);
}

/**
 * Words in no other test's questions. Each run's database is fresh, but the
 * three engines share it and leave answered questions in it, and the duplicate check rates two
 * titles one word apart about 0.91 alike, past the 0.88 at which posting waits
 * for "Mine is different". Four words of its own bring a title to about 0.68.
 */
export function runWords(browserName: string): string {
  return [browserName, ...Array.from({ length: 4 }, () => String(randomInt(1000, 10_000)))].join(' ');
}

/**
 * Opens a brand-new page at the home page. In CI, Playwright's Firefox driver sometimes never hears
 * a fresh page navigate (runs 39345142715, 39350901816, 39385304222): every request answered 200,
 * the page was fully drawn and its document "complete", yet no navigation event arrived. page.goto
 * then waits out the whole test, and so does every later step ("waiting for navigation to
 * finish"). A second navigation is tracked afresh, and must itself load: a page that really
 * hangs still fails.
 */
export async function openHome(page: Page) {
  try {
    await page.goto('/', { timeout: 20_000 });
  } catch (err) {
    if (!(err instanceof errors.TimeoutError)) throw err;
    await page.goto('/', { timeout: 20_000 });
  }
}

/**
 * Watches for the one-time privacy update (ADR 0015) a signed-in page asks for
 * once, and answers "Not now" if it was still waiting, so it never covers a
 * test's next step. Keyed to the app's own request, not a timeout. `cancel`
 * stands it down (sign-in that lands on setup leaves answering to setup: two
 * watchers would both click, and the second would wait for a sheet that's gone).
 */
export function answerPrivacyUpdateWhenAsked(page: Page): { done: Promise<void>; cancel: () => void } {
  let cancelled = false;
  const done = page
    .waitForResponse(r => new URL(r.url()).pathname === '/me/consents' && r.request().method() === 'GET', {
      timeout: 30_000,
    })
    .then(async r => {
      const body = (await r.json()) as { awaitingAnswer?: string[] };
      if (cancelled || !body.awaitingAnswer?.length) return;
      const sheet = page.getByRole('dialog', { name: 'Two privacy updates' });
      await sheet.getByRole('button', { name: 'Not now' }).click();
      await expect(sheet).toBeHidden();
    });
  return {
    done,
    cancel: () => {
      cancelled = true;
      done.catch(() => undefined);
    },
  };
}

/** Signs in through the local stand-in as one of its people. */
export async function signIn(page: Page, who: 'Test person A' | 'A brand-new person') {
  await openHome(page);
  await page.getByRole('button', { name: 'Continue with Google' }).click();
  const answered = answerPrivacyUpdateWhenAsked(page);
  await page.getByRole('button', { name: who }).click();
  // The app finishes sign-in by moving to home or to setup; wait for either,
  // or a test's next page.goto collides with that move (seen in WebKit).
  const home = page.getByRole('link', { name: 'Ask a question' });
  await expect(page.getByRole('heading', { name: 'Choose your name' }).or(home)).toBeVisible();
  // Landing on setup, the request comes after setup, and setUpIfNeeded answers then.
  if (await home.isVisible()) await answered.done;
  else answered.cancel();
}

/** Finishes setup if this person hasn't yet (a fixed test person only needs it once). */
export async function setUpIfNeeded(page: Page, handle: string, options: { answerPrivacyUpdate?: boolean } = {}) {
  // Signing in lands on the home page, then the app sends a newcomer to
  // setup: wait until it has settled into one or the other.
  const setup = page.getByRole('heading', { name: 'Choose your name' });
  await expect(setup.or(page.getByRole('link', { name: 'Ask a question' }))).toBeVisible();
  if (!(await setup.isVisible())) return;
  await page.getByLabel('Name').fill(handle);
  await expect(page.getByText('Available')).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Country').selectOption('IN');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Imports & Customs' }).click();
  await page.getByText('I’m 18 or older').click();
  const answered = options.answerPrivacyUpdate === false ? null : answerPrivacyUpdateWhenAsked(page);
  await page.getByRole('button', { name: 'Create profile' }).click();
  // Setup ends by moving to the home page; let that finish before going on.
  await expect(page.getByRole('link', { name: 'Ask a question' })).toBeVisible();
  await answered?.done;
}

export async function signOut(page: Page) {
  await page.goto('/me');
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeVisible();
}

/** Runs one statement on the local database as its owner (what the owner would do in the SQL editor). */
export async function asOwner(sql: string, values: unknown[]) {
  const pg = (await import('pg')).default;
  const client = new pg.Client({ connectionString: e2eUrl() });
  await client.connect();
  try {
    await client.query(sql, values);
  } finally {
    await client.end();
  }
}

/** Reads from the local database as its owner, to check what the app stored. */
export async function readAsOwner<T>(sql: string, values: unknown[]): Promise<T[]> {
  const pg = (await import('pg')).default;
  const client = new pg.Client({ connectionString: e2eUrl() });
  await client.connect();
  try {
    return (await client.query(sql, values)).rows as T[];
  } finally {
    await client.end();
  }
}

export const TEST_PERSON_A = '11111111-1111-4111-8111-111111111111';

/** Test person A is reused across runs: an established member, past the new-account limits. */
export async function establishTestPersonA() {
  await asOwner("UPDATE app.profiles SET created_at = now() - interval '30 days' WHERE id = $1", [TEST_PERSON_A]);
}

/** Each test starts with no console errors recorded, so one test's errors can't fail another. */
export function clearConsoleErrors() {
  consoleErrors.length = 0;
}
