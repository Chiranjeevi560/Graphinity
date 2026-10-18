// Walks every screen built so far, the way a person would, and measures each
// one against the quality bar: accessibility (axe, WCAG 2.2 AA) in light and
// dark, sideways scrolling at phone and desktop widths, tap target sizes,
// console errors and Content-Security-Policy violations.
//
// Findings are soft assertions: every problem on every screen is reported in
// one run, instead of stopping at the first.
import { mkdirSync, writeFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const WIDTHS = [320, 375, 430, 1280];
const MIN_TARGET = 44;

interface ScreenReport {
  screen: string;
  axe: Array<{ scheme: string; id: string; impact: string | null | undefined; nodes: number; help: string; where: string[] }>;
  overflow: number[];
  smallTargets: Array<{ width: number; label: string; w: number; h: number }>;
}

const reports: ScreenReport[] = [];
const consoleErrors: string[] = [];

/**
 * Playwright's WebKit screenshots inject a style element, which our CSP
 * refuses (two errors per screenshot pair, on every screen; none without
 * screenshots). Only with AUDIT_SHOTS, only in WebKit, only that message.
 */
function realErrors(errors: string[], browserName: string): string[] {
  if (!process.env.AUDIT_SHOTS || browserName !== 'webkit') return errors;
  return errors.filter(e => !e.endsWith(":: Refused to apply a stylesheet because its hash, its nonce, or 'unsafe-inline' does not appear in the style-src directive of the Content Security Policy."));
}

async function settle(page: Page) {
  await page.waitForLoadState('networkidle');
  // Wait out route fades so contrast is measured on final colours.
  await page.waitForFunction(() => document.getAnimations().every(a => a.playState !== 'running'));
}

async function audit(page: Page, screen: string) {
  const report: ScreenReport = { screen, axe: [], overflow: [], smallTargets: [] };
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await settle(page);
    const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
    for (const v of result.violations) {
      report.axe.push({
        scheme, id: v.id, impact: v.impact, nodes: v.nodes.length, help: v.help,
        // Which element, and axe's own one-line reason (it includes the measured ratio).
        where: v.nodes.map(n => `${n.target.join(' ')} :: ${(n.failureSummary ?? '').split('\n').slice(1).join(' ').slice(0, 160)}`),
      });
    }
  }
  await page.emulateMedia({ colorScheme: 'light' });
  const original = page.viewportSize();
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 800 });
    await settle(page);
    const { overflow, small } = await page.evaluate((min) => {
      const overflow = document.documentElement.scrollWidth > window.innerWidth;
      const small: Array<{ label: string; w: number; h: number }> = [];
      for (const el of document.querySelectorAll<HTMLElement>('a, button, input, select, textarea, [role="button"], label.checkbox')) {
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
          small.push({ label: (el.getAttribute('aria-label') ?? el.textContent).trim().slice(0, 40), w: Math.round(r.width), h: Math.round(r.height) });
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
      await page.screenshot({ path: `test-results/shots/${test.info().project.name}/${name}-${scheme}.png`, fullPage: true });
    }
    await page.emulateMedia({ colorScheme: 'light' });
  }
  if (original) await page.setViewportSize(original);
  reports.push(report);
  // Saved after every screen, so a later failure can't hide earlier findings.
  mkdirSync('test-results', { recursive: true });
  writeFileSync(`test-results/audit-${test.info().project.name}.json`, JSON.stringify({ reports, consoleErrors }, null, 2));

  expect.soft(report.axe.filter(v => v.impact === 'critical' || v.impact === 'serious'), `${screen}: serious accessibility problems`).toEqual([]);
  expect.soft(report.overflow, `${screen}: sideways scrolling at these widths`).toEqual([]);
  expect.soft(report.smallTargets, `${screen}: tap targets under ${MIN_TARGET}px`).toEqual([]);
}

test('every screen meets the bar', async ({ page, browserName }, testInfo) => {
  page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(`${page.url()} :: ${msg.text().slice(0, 200)}`); });
  page.on('pageerror', err => consoleErrors.push(`${page.url()} :: pageerror ${err.message.slice(0, 200)}`));

  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await audit(page, 'home (signed out)');
  // Search engines see each screen's own title and indexing rule.
  await expect(page).toHaveTitle('Graphinity: ask people who’ve actually done it');
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /^index/);

  await page.goto('/this/does/not/exist');
  await audit(page, 'not found');
  await expect(page).toHaveTitle('Page not found – Graphinity');
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex');
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', /\/this\/does\/not\/exist$/);

  // A malformed profile link reached inside the app is "not found", not the
  // error screen. (Loaded directly, the local preview server itself answers
  // 404 before the app runs; what Cloudflare does is checked after deploy.)
  await page.goto('/');
  await page.evaluate(() => { history.pushState(null, '', '/u/%E0'); window.dispatchEvent(new PopStateEvent('popstate')); });
  await expect(page.getByRole('heading', { name: 'This page doesn’t exist' })).toBeVisible();

  await page.goto('/u/nobody.here');
  await expect(page.getByText('There’s no one with that name.')).toBeVisible();
  await audit(page, 'public profile (missing)');

  // Coming back to this page from the browser's back/forward cache must
  // leave a working button. Test browsers reload instead of using that cache,
  // so hold the button in its "leaving" state by blocking the trip to sign-in,
  // then fire the event a cache restore fires.
  await page.goto('/');
  // A 204 answer cancels the navigation, so the page (and the button) stays.
  await page.route('**/o/oauth2/v2/auth**', route => route.fulfill({ status: 204 }));
  await page.getByRole('button', { name: 'Continue with Google' }).click();
  await expect(page.getByRole('button', { name: 'Opening Google…' })).toBeDisabled();
  await page.evaluate(() => { window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })); });
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeEnabled();
  await page.unroute('**/o/oauth2/v2/auth**');

  // If the browser can't start sign-in (here: hashing refused), the button
  // comes back instead of staying stuck on "Opening Google…".
  await page.evaluate(() => { crypto.subtle.digest = () => Promise.reject(new Error('blocked')); });
  await page.getByRole('button', { name: 'Continue with Google' }).click();
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeEnabled();

  // A file from an old deploy failing to load, with storage blocked: the page
  // must not reload itself (it couldn't remember doing so, and would loop).
  const reloaded = await page.evaluate(() => {
    Object.defineProperty(window, 'sessionStorage', { get() { throw new DOMException('blocked', 'SecurityError'); } });
    const e = new Event('vite:preloadError', { cancelable: true });
    window.dispatchEvent(e);
    return e.defaultPrevented;
  });
  expect(reloaded).toBe(false);
  await page.goto('/');

  // Sign in through the local stand-in. Google's ID token travels after "#",
  // so no server may ever see it in an address, and the address bar must be
  // clean by the time setup shows.
  const addresses: string[] = [];
  page.on('request', req => { addresses.push(req.url()); });
  await page.getByRole('button', { name: 'Continue with Google' }).click();
  await page.getByRole('button', { name: 'A brand-new person' }).click();
  await expect(page).toHaveURL(/\/welcome$/);
  expect(page.url()).not.toContain('id_token');
  expect(addresses.filter(a => /[?&#]id_token=/.test(a))).toEqual([]);
  expect(addresses.some(a => a.includes('/auth/v1/token?grant_type=id_token'))).toBe(true);
  await audit(page, 'welcome 1: name (empty)');

  const handle = `audit.${browserName}.${Date.now() % 1_000_000}`;
  await page.getByLabel('Name').fill(handle);
  await expect(page.getByText('Available')).toBeVisible();
  await audit(page, 'welcome 1: name (available)');
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(page.getByRole('heading', { name: 'Where do you live?' })).toBeVisible();
  // Choosing the empty option must stay empty, not snap back to a guess.
  await page.getByLabel('Country').selectOption('');
  await expect(page.getByLabel('Country')).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Continue' })).toBeDisabled();
  await page.getByLabel('Country').selectOption('IN');
  await audit(page, 'welcome 2: country');
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(page.getByRole('heading', { name: 'What do you know about?' })).toBeVisible();
  await page.getByRole('button', { name: 'Imports & Customs' }).click();
  await page.getByText('I’m 18 or older').click();
  await audit(page, 'welcome 3: fields');
  await page.getByRole('button', { name: 'Create profile' }).click();

  await expect(page.getByRole('link', { name: `Your profile, @${handle}` })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Ask a question' })).toBeVisible();
  await audit(page, 'home (signed in)');

  // Asking. The title is unique per run, so matching can be checked exactly.
  const run = `${browserName}${String(Date.now() % 1_000_000)}`;
  const title = `How do I import a vintage watch into the UAE, case ${run}?`;
  await page.getByRole('link', { name: 'Ask a question' }).click();
  await expect(page.getByRole('heading', { name: 'Ask a question' })).toBeVisible();
  await audit(page, 'ask (empty)');
  await page.getByLabel('Your question').fill(title);
  await page.getByLabel('Details (optional)').fill('Bought in Geneva.\nShipping to Dubai next month.');
  await page.getByLabel('About a country').selectOption('AE');
  await page.getByRole('button', { name: 'Post question' }).click();
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
  await expect(page).toHaveURL(/\/q\/\d+\/how-do-i-import-a-vintage-watch-into-the-uae-case-/);
  await expect(page).toHaveTitle(`${title} – Graphinity`);
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /^index/);
  await expect(page.getByText('This is your question.')).toBeVisible();
  await audit(page, 'question (yours)');
  const questionUrl = new URL(page.url()).pathname;

  // Typing a similar question shows it, from half-typed words.
  await page.goto('/ask');
  await page.getByLabel('Your question').fill(`vintage watch case ${run.slice(0, -2)}`);
  await expect(page.getByRole('region', { name: 'Similar questions already asked' }).getByRole('link', { name: new RegExp(run) })).toBeVisible();
  await audit(page, 'ask (similar questions)');
  await page.goto('/');
  await expect(page.getByRole('link', { name: new RegExp(run) }).first()).toBeVisible();

  await page.goto('/me');
  await expect(page.getByRole('heading', { name: `@${handle}` })).toBeVisible();
  await audit(page, 'your profile');

  await page.getByRole('button', { name: 'Delete account…' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await audit(page, 'delete dialog');
  await page.keyboard.press('Escape');

  await page.goto('/me/edit');
  await expect(page.getByRole('heading', { name: 'Edit profile' })).toBeVisible();
  await audit(page, 'edit profile');

  await page.goto(`/u/${handle}`);
  await expect(page.getByRole('heading', { name: `@${handle}` })).toBeVisible();
  await audit(page, 'public profile');

  // Signed out, anyone can read the question, and is invited to answer.
  await page.goto('/me');
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeVisible();
  await page.goto(questionUrl);
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
  await expect(page.getByText('Sign in to answer')).toBeVisible();
  await audit(page, 'question (signed out)');

  // A newcomer signs in from the question, sets up, and comes straight back to answer.
  await page.getByRole('button', { name: 'Continue with Google' }).click();
  await page.getByRole('button', { name: 'A brand-new person' }).click();
  await expect(page).toHaveURL(new RegExp(`${questionUrl}$`));
  await page.getByRole('link', { name: 'Set up profile' }).click();
  const answerer = `answer.${run}`;
  await page.getByLabel('Name').fill(answerer);
  await expect(page.getByText('Available')).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Country').selectOption('AE');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Imports & Customs' }).click();
  await page.getByText('I’m 18 or older').click();
  await page.getByRole('button', { name: 'Create profile' }).click();
  await expect(page).toHaveURL(new RegExp(`${questionUrl}$`));
  await page.getByLabel('Your answer').fill('Declare it on arrival and keep the Swiss export papers.\nDuty was 5% for me.');
  await audit(page, 'question (answering)');
  await page.getByRole('button', { name: 'Post answer' }).click();
  await expect(page.getByRole('heading', { name: '1 answer' })).toBeVisible();
  await expect(page.getByRole('link', { name: `@${answerer}`, exact: true })).toBeVisible();
  await expect(page.getByLabel('Your answer')).toHaveCount(0);
  await audit(page, 'question (answered)');

  await page.goto('/me');
  await page.getByRole('button', { name: 'Delete account…' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete account' }).click();
  await expect(page.getByRole('heading', { name: 'Your account is deleted' })).toBeVisible();
  await audit(page, 'goodbye');

  // CSP violations surface as console errors in every engine.
  // Only the one expected error: the missing profile's 404 from the API.
  const expected = (e: string) => e.startsWith('http://localhost:4173/u/nobody.here :: Failed to load resource: the server responded with a status of 404');
  expect.soft(realErrors(consoleErrors, browserName).filter(e => !expected(e)), 'console errors').toEqual([]);
  await testInfo.attach(`audit-${browserName}.json`, { body: JSON.stringify({ reports, consoleErrors }, null, 2), contentType: 'application/json' });
});

/** Signs in through the local stand-in as one of its people. */
async function signIn(page: Page, who: 'Test person A' | 'A brand-new person') {
  await page.goto('/');
  await page.getByRole('button', { name: 'Continue with Google' }).click();
  await page.getByRole('button', { name: who }).click();
  await page.waitForURL(url => !url.pathname.startsWith('/auth/'));
}

/** Finishes setup if this person hasn't yet (a fixed test person only needs it once). */
async function setUpIfNeeded(page: Page, handle: string) {
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
  await page.getByRole('button', { name: 'Create profile' }).click();
  // Setup ends by moving to the home page; let that finish before going on.
  await expect(page.getByRole('link', { name: 'Ask a question' })).toBeVisible();
}

async function signOut(page: Page) {
  await page.goto('/me');
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeVisible();
}

test('picking an answer moves points, and the profile shows them', async ({ page, browserName }) => {
  page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(`${page.url()} :: ${msg.text().slice(0, 200)}`); });
  const run = `${browserName}${String(Date.now() % 1_000_000)}`;

  // The asker: a fixed test person, so they can come back later.
  await signIn(page, 'Test person A');
  await setUpIfNeeded(page, `asker.${run}`);
  await page.goto('/ask');
  const title = `Which customs form do I need for a watch, case ${run}?`;
  await page.getByLabel('Your question').fill(title);
  await page.getByRole('button', { name: 'Post question' }).click();
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
  const questionUrl = new URL(page.url()).pathname;
  await signOut(page);

  // Two newcomers answer.
  const answerers = [`first.${run}`, `second.${run}`];
  for (const handle of answerers) {
    await signIn(page, 'A brand-new person');
    await setUpIfNeeded(page, handle);
    await page.goto(questionUrl);
    await page.getByLabel('Your answer').fill(`Form B/L 12 worked for me, says ${handle}.`);
    await page.getByRole('button', { name: 'Post answer' }).click();
    await expect(page.getByRole('link', { name: `@${handle}`, exact: true })).toBeVisible();
    await signOut(page);
  }

  // The asker comes back, picks the first answer, says it worked, marks the second helpful.
  await signIn(page, 'Test person A');
  await page.goto(questionUrl);
  const first = page.getByRole('listitem').filter({ hasText: `says first.${run}` });
  const second = page.getByRole('listitem').filter({ hasText: `says second.${run}` });
  await audit(page, 'question (asker, before picking)');
  await first.getByRole('button', { name: 'Pick as the answer that helped' }).click();
  await expect(first.getByText('Picked by the asker')).toBeVisible();
  await first.getByRole('group', { name: 'Did it turn out right?' }).getByRole('button', { name: 'Yes' }).click();
  await expect(first.getByText('Turned out right')).toBeVisible();
  await second.getByRole('button', { name: 'Mark helpful' }).click();
  await expect(second.getByText('Marked helpful')).toBeVisible();
  await audit(page, 'question (asker, picked)');

  // Changing the pick asks why, in a dialog.
  await second.getByRole('button', { name: 'Pick this instead' }).click();
  const dialog = page.getByRole('dialog', { name: 'Why are you changing your pick?' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Change pick' })).toBeDisabled();
  await audit(page, 'change pick dialog');
  await dialog.getByLabel('A better answer came later').check();
  await dialog.getByRole('button', { name: 'Change pick' }).click();
  await expect(dialog).toBeHidden();
  await expect(second.getByText('Picked by the asker')).toBeVisible();
  await expect(page.getByText('You can change your pick once more.')).toBeVisible();

  // The second answerer's profile now shows 7 points (5 for the pick, 2 for helpful).
  await page.goto(`/u/${answerers[1] ?? ''}`);
  await expect(page.getByRole('heading', { name: 'Helped people with' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Helped people with' }).getByRole('listitem').filter({ hasText: 'Imports & Customs' })).toContainText('7 points');
  await audit(page, 'public profile (with points)');
  // The first lost the pick's points when it moved.
  await page.goto(`/u/${answerers[0] ?? ''}`);
  await expect(page.getByRole('heading', { name: 'Helped people with' })).toHaveCount(0);

  expect.soft(realErrors(consoleErrors, browserName).filter(e => !e.includes('/u/nobody.here')), 'console errors').toEqual([]);
});
