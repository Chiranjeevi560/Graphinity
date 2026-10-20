// Every screen, measured against the quality bar (helpers.ts, audit).
import { audit, clearConsoleErrors, consoleErrors, expect, realErrors, reports, runWords, test } from './helpers.ts';

test.beforeEach(clearConsoleErrors);

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
  const words = runWords(browserName);
  const title = `How do I import a vintage watch into the UAE, case ${words}?`;
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
  await page.getByLabel('Your question').fill(`vintage watch case ${words.slice(0, -2)}`);
  await expect(
    page
      .getByRole('region', { name: 'Similar questions already asked' })
      .getByRole('link', { name: new RegExp(words) }),
  ).toBeVisible();
  await audit(page, 'ask (similar questions)');
  await page.goto('/');
  await expect(page.getByRole('link', { name: new RegExp(words) }).first()).toBeVisible();

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
