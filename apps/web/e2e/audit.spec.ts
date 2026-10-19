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

const reports: ScreenReport[] = [];
const consoleErrors: string[] = [];

/**
 * Playwright's WebKit screenshots inject a style element, which our CSP
 * refuses (two errors per screenshot pair, on every screen; none without
 * screenshots). Only with AUDIT_SHOTS, only in WebKit, only that message.
 */
function realErrors(errors: string[], browserName: string): string[] {
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
const inFlight = new WeakMap<Page, Set<object>>();
function track(page: Page): Set<object> {
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

async function settle(page: Page) {
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
  // Wait out route fades so contrast is measured on final colours.
  await page.waitForFunction(() => document.getAnimations().every(a => a.playState !== 'running'));
}

async function audit(page: Page, screen: string) {
  const report: ScreenReport = { screen, axe: [], overflow: [], smallTargets: [] };
  // From the top, as the screen first appears: part-way down, anything near
  // the top is under the sticky header, which says nothing about the screen.
  await page.evaluate(() => {
    window.scrollTo(0, 0);
  });
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await settle(page);
    const result = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
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

test('every screen meets the bar', async ({ page, browserName }, testInfo) => {
  page.on('console', msg => {
    if (msg.type() === 'error') consoleErrors.push(`${page.url()} :: ${msg.text().slice(0, 200)}`);
  });
  page.on('pageerror', err => consoleErrors.push(`${page.url()} :: pageerror ${err.message.slice(0, 200)}`));

  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await audit(page, 'home (signed out)');
  // Search engines see each screen's own title and indexing rule.
  await expect(page).toHaveTitle('Graphinity: ask people who’ve actually done it');
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /^index/);

  await page.goto('/privacy');
  await expect(page.getByRole('heading', { name: 'Privacy', level: 1 })).toBeVisible();
  await audit(page, 'privacy');
  await page.goto('/terms');
  await expect(page.getByRole('heading', { name: 'Terms', level: 1 })).toBeVisible();
  await audit(page, 'terms');

  await page.goto('/this/does/not/exist');
  // As for every screen: on the page before auditing, or axe can catch its fade before it starts.
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await audit(page, 'not found');
  await expect(page).toHaveTitle('Page not found – Graphinity');
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex');
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', /\/this\/does\/not\/exist$/);

  // A malformed profile link reached inside the app is "not found", not the
  // error screen. (Loaded directly, the local preview server itself answers
  // 404 before the app runs; what Cloudflare does is checked after deploy.)
  await page.goto('/');
  await page.evaluate(() => {
    history.pushState(null, '', '/u/%E0');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  await expect(page.getByRole('heading', { name: 'This page doesn’t exist' })).toBeVisible();

  await page.goto('/u/nobody.here');
  await expect(page.getByRole('heading', { name: 'There’s no one with that name' })).toBeVisible();
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
  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  });
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeEnabled();
  await page.unroute('**/o/oauth2/v2/auth**');

  // If the browser can't start sign-in (here: hashing refused), the button
  // comes back instead of staying stuck on "Opening Google…".
  await page.evaluate(() => {
    crypto.subtle.digest = () => Promise.reject(new Error('blocked'));
  });
  await page.getByRole('button', { name: 'Continue with Google' }).click();
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeEnabled();

  // A file from an old deploy failing to load, with storage blocked: the page
  // must not reload itself (it couldn't remember doing so, and would loop).
  const reloaded = await page.evaluate(() => {
    Object.defineProperty(window, 'sessionStorage', {
      get() {
        throw new DOMException('blocked', 'SecurityError');
      },
    });
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
  page.on('request', req => {
    addresses.push(req.url());
  });
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
  await page.getByLabel('Topic').selectOption('imports-customs');
  await page.getByRole('button', { name: 'Post question' }).click();
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
  await expect(page).toHaveURL(/\/q\/\d+\/how-do-i-import-a-vintage-watch-into-the-uae-case-/);
  await expect(page).toHaveTitle(`${title} – Graphinity`);
  // Spec §19.2: unanswered, it stays out of search (indexed once answered, below).
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex');
  await expect(page.getByText('This is your question.')).toBeVisible();
  await audit(page, 'question (yours)');
  const questionUrl = new URL(page.url()).pathname;

  // Typing a similar question shows it, from half-typed words.
  await page.goto('/ask');
  await page.getByLabel('Your question').fill(`vintage watch case ${run.slice(0, -2)}`);
  await expect(
    page.getByRole('region', { name: 'Similar questions already asked' }).getByRole('link', { name: new RegExp(run) }),
  ).toBeVisible();
  await audit(page, 'ask (similar questions)');
  await page.goto('/');
  await expect(page.getByRole('link', { name: new RegExp(run) }).first()).toBeVisible();

  await page.goto('/me');
  await expect(page.getByRole('heading', { name: `@${handle}` })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Turn on for this device' })).toBeVisible();
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
  await page
    .getByLabel('Your answer')
    .fill('Declare it on arrival and keep the Swiss export papers.\nDuty was 5% for me.');
  await audit(page, 'question (answering)');
  await page.getByRole('button', { name: 'Post answer' }).click();
  await expect(page.getByRole('heading', { name: '1 answer' })).toBeVisible();
  await expect(page.getByRole('link', { name: `@${answerer}`, exact: true })).toBeVisible();
  await expect(page.getByLabel('Your answer')).toHaveCount(0);
  await audit(page, 'question (answered)');
  // Loaded fresh, the way a search engine sees it, an answered question is indexed.
  await page.goto(questionUrl);
  await expect(page.getByRole('heading', { name: '1 answer' })).toBeVisible();
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /^index/);

  // A question half-written, then the account deleted: nothing is left behind in the tab.
  await page.goto('/ask');
  await page.getByLabel('Your question').fill('Something I started and never sent');
  await page.goto('/me');
  await page.getByRole('button', { name: 'Delete account…' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete account' }).click();
  await expect(page.getByRole('heading', { name: 'Your account is deleted' })).toBeVisible();
  expect(await page.evaluate(() => Object.keys(sessionStorage).filter(k => k.startsWith('graphinity.draft.')))).toEqual(
    [],
  );
  await audit(page, 'goodbye');

  // CSP violations surface as console errors in every engine.
  // Only the one expected error: the missing profile's 404 from the API.
  const expected = (e: string) =>
    e.startsWith(
      'http://localhost:4173/u/nobody.here :: Failed to load resource: the server responded with a status of 404',
    );
  expect
    .soft(
      realErrors(consoleErrors, browserName).filter(e => !expected(e)),
      'console errors',
    )
    .toEqual([]);
  await testInfo.attach(`audit-${browserName}.json`, {
    body: JSON.stringify({ reports, consoleErrors }, null, 2),
    contentType: 'application/json',
  });
});

/** Signs in through the local stand-in as one of its people. */
async function signIn(page: Page, who: 'Test person A' | 'A brand-new person') {
  await page.goto('/');
  await page.getByRole('button', { name: 'Continue with Google' }).click();
  await page.getByRole('button', { name: who }).click();
  // The app finishes sign-in by moving to home or to setup; wait for either,
  // or a test's next page.goto collides with that move (seen in WebKit).
  await expect(
    page.getByRole('heading', { name: 'Choose your name' }).or(page.getByRole('link', { name: 'Ask a question' })),
  ).toBeVisible();
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
  page.on('console', msg => {
    if (msg.type() === 'error') consoleErrors.push(`${page.url()} :: ${msg.text().slice(0, 200)}`);
  });
  const run = `${browserName}${String(Date.now() % 1_000_000)}`;

  // The asker: a fixed test person, so they can come back later.
  await signIn(page, 'Test person A');
  await setUpIfNeeded(page, `asker.${run}`);
  await establishTestPersonA();
  await page.goto('/ask');
  const title = `Which customs form do I need for a watch, case ${run}?`;
  await page.getByLabel('Your question').fill(title);
  await page.getByLabel('Topic').selectOption('imports-customs');
  await page.getByRole('button', { name: 'Post question' }).click();
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
  const questionUrl = new URL(page.url()).pathname;
  // The asker watches it go out, and reads where it went in words.
  await expect(page.locator('.routing-graph figcaption')).toContainText(
    /(Sent to .+|Finding people|Nobody) who know Imports & Customs|could be asked yet/,
  );
  const routing = page.locator('.routing-graph-canvas');
  const look = () =>
    routing.evaluate((c: HTMLCanvasElement) => {
      const d = (c.getContext('2d') as CanvasRenderingContext2D).getImageData(0, 0, c.width, c.height).data;
      let h = 0;
      for (let i = 3; i < d.length; i += 16) h = (h * 31 + (d[i] ?? 0)) | 0;
      return h;
    });
  const before = await look();
  await page.waitForTimeout(300);
  expect(await look()).not.toBe(before);
  await signOut(page);

  // Two newcomers answer.
  const answerers = [`first.${run}`, `second.${run}`];
  for (const handle of answerers) {
    await signIn(page, 'A brand-new person');
    await setUpIfNeeded(page, handle);
    await page.goto(questionUrl);
    await page.getByLabel('Your answer').fill(`Form B/L 12 worked for me, says ${handle}.`);
    // For the second, the page can't update after posting: it must say the answer is posted,
    // not invite a second try.
    const refresh = (url: URL) =>
      /^\/questions\/[0-9]+$/.test(url.pathname) && url.origin !== new URL(page.url()).origin;
    const errorsBefore = consoleErrors.length;
    if (handle === answerers[1])
      await page.route(refresh, route => (route.request().method() === 'GET' ? route.abort() : route.continue()));
    await page.getByRole('button', { name: 'Post answer' }).click();
    if (handle === answerers[1]) {
      await expect(
        page.getByRole('status').filter({ hasText: 'Your answer is posted. Reload the page to see it.' }),
      ).toBeVisible();
      await page.unroute(refresh);
      // The browser logs the failure this step caused on purpose; anything else still counts.
      consoleErrors.push(
        ...consoleErrors.splice(errorsBefore).filter(e => !e.endsWith(':: Failed to load resource: net::ERR_FAILED')),
      );
      await page.reload();
    }
    await expect(page.getByRole('link', { name: `@${handle}`, exact: true })).toBeVisible();
    await signOut(page);
  }

  // The asker comes back, picks the first answer, says it worked, marks the second helpful.
  await signIn(page, 'Test person A');
  await page.goto(questionUrl);
  const first = page.getByRole('listitem').filter({ hasText: `says first.${run}` });
  const second = page.getByRole('listitem').filter({ hasText: `says second.${run}` });
  await audit(page, 'question (asker, before picking)');
  await first.getByRole('button', { name: 'This helped me' }).click();
  await expect(first.getByText('Helped the asker')).toBeVisible();
  await first.getByRole('group', { name: 'Did it turn out right?' }).getByRole('button', { name: 'Yes' }).click();
  await expect(first.getByText('Helped the asker · turned out right')).toBeVisible();
  await expect(
    first.getByRole('group', { name: 'Did it turn out right?' }).getByRole('button', { name: 'Yes' }),
  ).toHaveAttribute('aria-pressed', 'true');
  // One tap (or one key) rates it.
  const stars = first.getByRole('radiogroup', { name: 'How good was it?' });
  await stars.getByRole('radio', { name: '4 stars' }).focus();
  await page.keyboard.press('Enter');
  await expect(stars.getByRole('radio', { name: '4 stars' })).toHaveAttribute('aria-checked', 'true');
  await second.getByRole('button', { name: 'Also useful' }).click();
  await expect(second.getByText('Useful to the asker')).toBeVisible();
  await audit(page, 'question (asker, picked)');

  // Changing the pick asks why, in a dialog.
  await second.getByRole('button', { name: 'This helped more' }).click();
  const dialog = page.getByRole('dialog', { name: 'Why are you changing your pick?' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Change pick' })).toBeDisabled();
  await audit(page, 'change pick dialog');
  await dialog.getByLabel('A better answer came later').check();
  await dialog.getByRole('button', { name: 'Change pick' }).click();
  await expect(dialog).toBeHidden();
  await expect(second.getByText('Helped the asker')).toBeVisible();
  await expect(page.getByText('You can change your pick 1 more time.')).toBeVisible();

  // The second answerer's profile now shows 7 points (5 for the pick, 2 for helpful).
  await page.goto(`/u/${answerers[1] ?? ''}`);
  await expect(page.getByRole('heading', { name: 'Helped people with' })).toBeVisible();
  await expect(
    page
      .getByRole('region', { name: 'Helped people with' })
      .getByRole('listitem')
      .filter({ hasText: 'Imports & Customs' }),
  ).toContainText('7 points');
  await audit(page, 'public profile (with points)');
  // The first lost the pick's points when it moved.
  await page.goto(`/u/${answerers[0] ?? ''}`);
  await expect(page.getByRole('heading', { name: 'Helped people with' })).toHaveCount(0);

  expect
    .soft(
      realErrors(consoleErrors, browserName).filter(e => !e.includes('/u/nobody.here')),
      'console errors',
    )
    .toEqual([]);
});

test('a new answer reaches the asker live, without reloading', async ({ browser, browserName }) => {
  const run = `${browserName}${String(Date.now() % 1_000_000)}`;
  const askerContext = await browser.newContext();
  const answererContext = await browser.newContext();
  try {
    const asker = await askerContext.newPage();
    await signIn(asker, 'Test person A');
    await setUpIfNeeded(asker, `asker.${run}`);
    await establishTestPersonA();
    await asker.goto('/ask');
    const title = `Is there a night bus from the airport, case ${run}?`;
    await asker.getByLabel('Your question').fill(title);
    await asker.getByLabel('Topic').selectOption('imports-customs');
    await asker.getByRole('button', { name: 'Post question' }).click();
    await expect(asker.getByRole('heading', { level: 1, name: title })).toBeVisible();
    const questionUrl = new URL(asker.url()).pathname;
    // The asker waits on the home page.
    await asker.goto('/');
    await expect(asker.getByRole('link', { name: 'Ask a question' })).toBeVisible();

    const answerer = await answererContext.newPage();
    await signIn(answerer, 'A brand-new person');
    await setUpIfNeeded(answerer, `night.${run}`);
    await answerer.goto(questionUrl);
    await answerer.getByLabel('Your answer').fill('Yes, the N1 leaves every 30 minutes until 2am.');
    await answerer.getByRole('button', { name: 'Post answer' }).click();
    await expect(answerer.getByRole('heading', { name: '1 answer' })).toBeVisible();

    // Without reloading, the asker hears about it and can go straight there.
    const banner = asker.getByRole('link', { name: 'New answer to your question' });
    await expect(banner).toBeVisible({ timeout: 10_000 });
    // Focused, as a keyboard user reaching it would: it stays while they read.
    await banner.focus();
    await audit(asker, 'live banner');
    await banner.click();
    await expect(asker.getByText('the N1 leaves every 30 minutes')).toBeVisible();
  } finally {
    await askerContext.close();
    await answererContext.close();
  }
});

/** Runs one statement on the local database as its owner (what the owner would do in the SQL editor). */
async function asOwner(sql: string, values: unknown[]) {
  const { readFileSync } = await import('node:fs');
  const pg = (await import('pg')).default;
  let adminUrl = process.env.ADMIN_URL;
  if (!adminUrl) {
    const env = readFileSync('.local/test.env', 'utf8');
    adminUrl = /^TEST_DATABASE_ADMIN_URL=(.+)$/m.exec(env)?.[1];
  }
  if (!adminUrl) throw new Error('No admin URL: set ADMIN_URL or run npm run db:start');
  const url = new URL(adminUrl);
  url.pathname = '/graphinity';
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  try {
    await client.query(sql, values);
  } finally {
    await client.end();
  }
}

const TEST_PERSON_A = '11111111-1111-4111-8111-111111111111';

/** Test person A is reused across runs: an established member, past the new-account limits. */
async function establishTestPersonA() {
  await asOwner("UPDATE app.profiles SET created_at = now() - interval '30 days' WHERE id = $1", [TEST_PERSON_A]);
}

test('a moderator removes a reported question', async ({ page, browserName }) => {
  const run = `${browserName}${String(Date.now() % 1_000_000)}`;
  // Someone new asks something that shouldn't be there.
  await signIn(page, 'A brand-new person');
  await setUpIfNeeded(page, `spammer.${run}`);
  await page.goto('/ask');
  const title = `Cheap watches here, visit my shop now, case ${run}?`;
  await page.getByLabel('Your question').fill(title);
  await page.getByLabel('Topic').selectOption('imports-customs');
  await page.getByRole('button', { name: 'Post question' }).click();
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
  const questionUrl = new URL(page.url()).pathname;
  await signOut(page);

  // Test person A (fixed id in the stand-in) is a moderator.
  await signIn(page, 'Test person A');
  await setUpIfNeeded(page, `moderator.${run}`);
  await establishTestPersonA();
  await asOwner('INSERT INTO app.moderators (profile_id) VALUES ($1) ON CONFLICT DO NOTHING', [TEST_PERSON_A]);
  await page.goto(questionUrl);
  await page.getByRole('article').getByRole('button', { name: 'Report' }).click();
  const dialog = page.getByRole('dialog', { name: 'Report this question' });
  await expect(dialog.getByRole('button', { name: 'Send report' })).toBeDisabled();
  await audit(page, 'report dialog');
  await dialog.getByLabel('Spam or advertising').check();
  await dialog.getByLabel('Anything to add? (optional)').fill('Advertising a shop');
  await dialog.getByRole('button', { name: 'Send report' }).click();
  await expect(page.getByRole('article').getByText('Reported')).toBeFocused();

  // The review lists it; the moderator removes it.
  await page.goto('/me');
  await page.getByRole('link', { name: 'Review reports' }).click();
  await expect(page.getByRole('heading', { name: 'Review', level: 1 })).toBeVisible();
  const item = page.getByRole('listitem').filter({ hasText: title });
  await expect(item).toContainText('Advertising a shop');
  await audit(page, 'review');
  await item.getByRole('button', { name: 'Remove' }).click();
  await expect(item.getByText('Removed.')).toBeVisible();
  // Removing doesn't take away blocking the author, a separate step.
  await expect(item.getByRole('button', { name: 'Keep' })).toHaveCount(0);
  await item.getByRole('button', { name: `Block @spammer.${run}` }).click();
  await expect(item.getByText(`@spammer.${run} is blocked from posting.`)).toBeVisible();
  await expect(item.getByRole('button')).toHaveCount(0);
  // A moderator can still open it (the page sends the sign-in when there is one).
  await page.goto(questionUrl);
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();

  // Gone for everyone else.
  await signOut(page);
  await page.goto(questionUrl);
  await expect(page.getByRole('heading', { name: 'This question doesn’t exist' })).toBeVisible();
  await expect(page.getByText('It may have been deleted.')).toBeVisible();
});

test('when Graphinity can’t be reached, every page says so truthfully and recovers', async ({ page }) => {
  page.on('console', msg => {
    if (msg.type() === 'error') consoleErrors.push(`${page.url()} :: ${msg.text().slice(0, 200)}`);
  });
  // The API refuses every connection: the device is online, our server isn't answering.
  const api = (url: URL) => url.port === '3000';
  await page.route(api, route => route.abort('connectionrefused'));
  const errorsBefore = consoleErrors.length;

  await page.goto('/');
  const failed = page.getByRole('alert').filter({ hasText: 'Graphinity isn’t responding' });
  await expect(failed).toBeVisible();
  // Never blame a connection that works.
  await expect(page.getByText('offline', { exact: false })).toHaveCount(0);
  await audit(page, 'home (server unreachable)');

  // A question that couldn't load isn't "deleted": it offers to try again.
  await page.goto('/q/1');
  await expect(page.getByRole('heading', { level: 1, name: 'Graphinity isn’t responding' })).toBeVisible();
  await expect(page.getByText('This question doesn’t exist')).toHaveCount(0);
  await audit(page, 'question (server unreachable)');

  // Server back: Try again brings the page back, no reload needed.
  await page.goto('/');
  await expect(failed).toBeVisible();
  await page.unroute(api);
  await failed.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('heading', { name: 'Recent questions' })).toBeVisible();
  await expect(failed).toHaveCount(0);

  // The device itself goes offline: now, and only now, the page says so.
  // (The privacy page is visited first, so its code is already downloaded.)
  await page.locator('.site-footer').getByRole('link', { name: 'Privacy' }).click();
  await page.getByRole('link', { name: 'Graphinity home' }).click();
  await expect(page.locator('.question-row').first()).toBeVisible();
  await page.context().setOffline(true);
  await page.locator('.site-footer').getByRole('link', { name: 'Privacy' }).click();
  await page.getByRole('link', { name: 'Graphinity home' }).click();
  const offline = page.getByRole('alert').filter({ hasText: 'You’re offline' });
  await expect(offline).toBeVisible();
  // Back online: what failed loads again by itself, without a tap or a reload.
  await page.context().setOffline(false);
  await expect(offline).toHaveCount(0);
  await expect(page.locator('.question-row').first()).toBeVisible();

  // The failures above were caused on purpose; anything else still counts.
  consoleErrors.push(
    ...consoleErrors
      .splice(errorsBefore)
      .filter(e => !/Failed to load resource|ERR_CONNECTION_REFUSED|ERR_INTERNET_DISCONNECTED/.test(e)),
  );
});

test('the home graph is alive, and holds still for people who turn motion off', async ({ page }) => {
  const canvas = page.locator('canvas.living-graph-canvas');
  // A fingerprint of what's drawn, to tell a moving picture from a still one.
  const drawn = () =>
    canvas.evaluate((c: HTMLCanvasElement) => {
      const d = (c.getContext('2d') as CanvasRenderingContext2D).getImageData(0, 0, c.width, c.height).data;
      let h = 0,
        ink = 0;
      for (let i = 3; i < d.length; i += 4) {
        if (d[i] !== 0) ink++;
        h = (h * 31 + (d[i] ?? 0)) | 0;
      }
      return { h, ink };
    });

  await page.goto('/');
  await expect(canvas).toBeVisible();
  await expect(page.locator('.living-graph figcaption')).toContainText(/people? across/);
  await expect.poll(async () => (await drawn()).ink).toBeGreaterThan(0);
  const first = await drawn();
  await page.waitForTimeout(800);
  expect((await drawn()).h).not.toBe(first.h);

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.reload();
  await expect.poll(async () => (await drawn()).ink).toBeGreaterThan(0);
  const still = await drawn();
  await page.waitForTimeout(800);
  expect((await drawn()).h).toBe(still.h);
});

test('what you type survives a reload and a failed post, and is forgotten when you sign out', async ({
  page,
  browserName,
}) => {
  const run = `${browserName}${String(Date.now() % 1_000_000)}`;
  const title = `Can I bring two laptops through Delhi customs, draft ${run}?`;
  const answer = `I brought two through Delhi in March, draft ${run}. Nobody asked about the second one.`;
  await signIn(page, 'Test person A');
  await establishTestPersonA();

  await page.goto('/ask');
  await page.getByLabel('Topic').selectOption('imports-customs');
  await page.getByLabel('Your question').fill(title);
  await page.reload();
  await expect(page.getByLabel('Your question')).toHaveValue(title);
  await expect(page.getByLabel('Topic')).toHaveValue('imports-customs');

  // The connection drops as it's posted: an error, and the words stay.
  const questions = 'http://localhost:3000/questions';
  await page.route(questions, route =>
    route.request().method() === 'POST' ? route.abort('internetdisconnected') : route.continue(),
  );
  const earlier = page.getByRole('button', { name: 'Mine is different' });
  await expect(page.getByRole('button', { name: 'Post question' }).or(earlier)).toBeVisible();
  if (await earlier.isVisible()) await earlier.click();
  await page.getByRole('button', { name: 'Post question' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Graphinity isn’t responding' })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Your question')).toHaveValue(title);
  await page.unroute(questions);

  // Back online it posts, and the draft is gone.
  if (await earlier.isVisible()) await earlier.click();
  await page.getByRole('button', { name: 'Post question' }).click();
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
  const questionUrl = new URL(page.url()).pathname;
  await page.goto('/ask');
  await expect(page.getByLabel('Your question')).toHaveValue('');

  // Someone else's answer in progress is kept per question, the same way.
  await signOut(page);
  await signIn(page, 'A brand-new person');
  await setUpIfNeeded(page, `drafter.${run}`);
  await page.goto(questionUrl);
  await page.getByLabel('Your answer').fill(answer);
  await page.reload();
  await expect(page.getByLabel('Your answer')).toHaveValue(answer);

  // Signing out forgets every draft in the tab.
  await page.goto('/ask');
  await page.getByLabel('Your question').fill('A question I never sent');
  await signOut(page);
  expect(await page.evaluate(() => Object.keys(sessionStorage).filter(k => k.startsWith('graphinity.draft.')))).toEqual(
    [],
  );
});

test('the graph can be explored from the keyboard, field by field', async ({ page }) => {
  // A fixed graph of four fields: the test data has people in only one.
  const field = (slug: string, name: string, members: number) => ({ slug, name, members });
  const graph = {
    members: 60,
    fields: [
      field('imports-customs', 'Imports & Customs', 40),
      field('travel', 'Travel', 20),
      field('fitness', 'Fitness', 9),
      field('food-cooking', 'Food & Cooking', 3),
    ],
    people: [
      ...Array.from({ length: 12 }, () => [0, 1]),
      ...Array.from({ length: 28 }, () => [0]),
      ...Array.from({ length: 8 }, () => [1]),
      ...Array.from({ length: 9 }, () => [2]),
      [3],
      [3],
      [3],
    ],
    links: [
      { a: 0, b: 1, shared: 12 },
      { a: 0, b: 2, shared: null },
    ],
    activity: { lastDay: { questions: 0, answers: 0 }, recent: [] },
  };
  await page.route('http://localhost:3000/graph', route =>
    route.fulfill({
      json: graph,
      headers: { 'access-control-allow-origin': 'http://localhost:4173', 'access-control-allow-credentials': 'true' },
    }),
  );
  await page.goto('/');
  const nav = page.getByRole('navigation', { name: 'Fields in the graph' });
  const nodes = nav.getByRole('button');
  await expect(nodes.first()).toBeAttached();
  const count = await nodes.count();
  expect(count).toBe(4);
  // One Tab stop for the whole graph, on the biggest field.
  await expect(nav.locator('button[tabindex="0"]')).toHaveCount(1);
  for (let i = 0; i < 20 && !(await nav.evaluate(n => n.contains(document.activeElement))); i++)
    await page.keyboard.press('Tab');
  await expect(nodes.first()).toBeFocused();
  await expect(nodes.first()).toHaveAccessibleName('Imports & Customs, 40 people');
  await expect(nodes.nth(3)).toHaveAccessibleName('Food & Cooking, a few people');
  // Arrows move by size; they stop at the ends instead of wrapping.
  await page.keyboard.press('ArrowRight');
  await expect(nodes.nth(1)).toBeFocused();
  await page.keyboard.press('End');
  await expect(nodes.nth(count - 1)).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(nodes.nth(count - 1)).toBeFocused();
  await page.keyboard.press('Home');
  await expect(nodes.first()).toBeFocused();
  // Opening a field says who knows it and where else they reach.
  await page.keyboard.press('Enter');
  await expect(nodes.first()).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('.graph-detail')).toHaveText(
    '40 people know Imports & Customs. 12 also know Travel, and a few also know Fitness.',
  );
  await page.keyboard.press('Enter');
  await expect(page.locator('.graph-detail')).toHaveText('');
  // Tab leaves the graph in one step, and comes back to where it was.
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Tab');
  expect(await nav.evaluate(n => n.contains(document.activeElement))).toBe(false);
  await page.keyboard.press('Shift+Tab');
  await expect(nodes.nth(1)).toBeFocused();
  // Each field's button sits on its cluster, and is at least a finger wide.
  for (let i = 0; i < count; i++) {
    const box = await nodes.nth(i).boundingBox();
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
  }
  await audit(page, 'home graph (keyboard)');
});

test('answers that report amounts show how far they agree, and keep the odd one visible', async ({
  page,
  browserName,
}) => {
  const run = `${browserName}${String(Date.now() % 1_000_000)}`;
  await signIn(page, 'Test person A');
  await setUpIfNeeded(page, `asker.${run}`);
  await establishTestPersonA();
  await page.goto('/ask');
  const title = `How much customs did you pay on a watch through Chennai, case ${run}?`;
  await page.getByLabel('Your question').fill(title);
  await page.getByLabel('Topic').selectOption('imports-customs');
  await page.getByRole('button', { name: 'Post question' }).click();
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
  const questionUrl = new URL(page.url()).pathname;
  await signOut(page);

  const reports = [
    'Paid ₹95,000 in duty at Chennai air cargo.',
    'The duty came to ₹96,000 for me at Chennai.',
    'Paid ₹1,40,000 because my invoice didn’t match.',
  ];
  for (const [i, body] of reports.entries()) {
    await signIn(page, 'A brand-new person');
    await setUpIfNeeded(page, `amount${String(i)}.${run}`);
    await page.goto(questionUrl);
    await page.getByLabel('Your answer').fill(body);
    await page.getByRole('button', { name: 'Post answer' }).click();
    await expect(page.getByText(body)).toBeVisible();
    await signOut(page);
  }

  await page.goto(questionUrl);
  const summary = page.getByRole('region', { name: /agree|differ/ });
  await expect(summary).toBeVisible();
  await expect(summary).toContainText('₹95,000–₹96,000');
  await expect(summary).toContainText('₹1,40,000');
  const outlier = page.getByRole('listitem').filter({ hasText: 'Paid ₹1,40,000' });
  await expect(outlier.getByText('Different outcome · kept visible')).toBeVisible();
  await audit(page, 'question (answers agree in part)');
});

test('asking something already answered offers those answers first, and never forces them', async ({
  page,
  browserName,
}) => {
  const run = `${browserName}${String(Date.now() % 1_000_000)}`;
  const title = `Which documents did customs want for a used camera from Japan, case ${run}?`;
  // Someone asked it and got an answer.
  await signIn(page, 'A brand-new person');
  await setUpIfNeeded(page, `first.${run}`);
  await page.goto('/ask');
  await page.getByLabel('Topic').selectOption('imports-customs');
  const checked = page.waitForResponse(r => r.url().endsWith('/questions/precheck'));
  await page.getByLabel('Your question').fill(title);
  await checked;
  // Earlier runs leave the same question, answered, in the local database:
  // this person's situation is their own, so they say so, as anyone could.
  const earlier = page.getByRole('button', { name: 'Mine is different' });
  if (await earlier.isVisible()) await earlier.click();
  await page.getByRole('button', { name: 'Post question' }).click();
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
  const questionUrl = new URL(page.url()).pathname;
  await signOut(page);
  await signIn(page, 'A brand-new person');
  await setUpIfNeeded(page, `answers.${run}`);
  await page.goto(questionUrl);
  await page.getByLabel('Your answer').fill('They wanted the invoice and my passport copy, nothing else.');
  await page.getByRole('button', { name: 'Post answer' }).click();
  await expect(page.getByText('They wanted the invoice')).toBeVisible();
  await signOut(page);

  // Someone else starts asking the same thing.
  await signIn(page, 'Test person A');
  await establishTestPersonA();
  await page.goto('/ask');
  await page.getByLabel('Topic').selectOption('imports-customs');
  await page.getByLabel('Your question').fill(title);
  const card = page.getByRole('region', { name: 'This was asked and answered recently' });
  await expect(card).toBeVisible();
  await expect(card.getByRole('link', { name: 'Read the answers' })).toHaveAttribute(
    'href',
    new RegExp(`^${questionUrl.split('/').slice(0, 3).join('/')}`),
  );
  await expect(page.getByRole('button', { name: 'Post question' })).toBeDisabled();
  await expect(page.getByText('Read the answers above, or say yours is different.')).toBeVisible();
  await audit(page, 'ask (already answered)');
  // Their situation differs: they can still ask.
  await card.getByRole('button', { name: 'Mine is different' }).click();
  await expect(card).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Post question' })).toBeEnabled();
});
