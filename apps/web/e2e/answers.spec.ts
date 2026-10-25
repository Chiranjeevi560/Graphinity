// Asking and answering: picking an answer and its points, answers arriving live, drafts kept,
// amounts agreeing, and an answered question offered before asking again.
import {
  asOwner,
  audit,
  clearConsoleErrors,
  consoleErrors,
  establishTestPersonA,
  expect,
  realErrors,
  runWords,
  setUpIfNeeded,
  signIn,
  signOut,
  test,
} from './helpers.ts';

test.beforeEach(clearConsoleErrors);

test('picking an answer moves points, and the profile shows them', async ({ page, browserName }) => {
  page.on('console', msg => {
    if (msg.type() === 'error') consoleErrors.push(`${page.url()} :: ${msg.text().slice(0, 200)}`);
  });
  const run = `${browserName}${String(Date.now() % 1_000_000)}`;
  const words = runWords(browserName);

  // The asker: a fixed test person, so they can come back later.
  await signIn(page, 'Test person A');
  await setUpIfNeeded(page, `asker.${run}`);
  await establishTestPersonA();
  await page.goto('/ask');
  const title = `Which customs form do I need for a watch, case ${words}?`;
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
      // The browser logs the failure this step caused on purpose, each engine in its own words
      // (Firefox calls any cross-origin request with no answer a CORS failure); anything else still counts.
      consoleErrors.push(
        ...consoleErrors
          .splice(errorsBefore)
          .filter(
            e =>
              !e.endsWith(':: Failed to load resource: net::ERR_FAILED') &&
              !/:: \[JavaScript Error: "Cross-Origin Request Blocked: .* at http:\/\/localhost:3000\/questions\/[0-9]+\. \(Reason: CORS request did not succeed\)/.test(
                e,
              ),
          ),
      );
      await page.reload();
    }
    await expect(page.getByRole('link', { name: `@${handle}`, exact: true })).toBeVisible();
    const credibilityCounts = await page
      .locator('.answer-credibility')
      .evaluateAll(rows => rows.map(row => row.children.length));
    expect(credibilityCounts.every(count => count <= 6)).toBe(true);
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
  const words = runWords(browserName);
  const askerContext = await browser.newContext();
  const answererContext = await browser.newContext();
  try {
    const asker = await askerContext.newPage();
    await signIn(asker, 'Test person A');
    await setUpIfNeeded(asker, `asker.${run}`);
    await establishTestPersonA();
    await asker.goto('/ask');
    const title = `Is there a night bus from the airport, case ${words}?`;
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

test('what you type survives a reload and a failed post, and is forgotten when you sign out', async ({
  page,
  browserName,
}) => {
  const run = `${browserName}${String(Date.now() % 1_000_000)}`;
  const words = runWords(browserName);
  const title = `Can I bring two laptops through Delhi customs, draft ${words}?`;
  const answer = `I brought two through Delhi in March, draft ${words}. Nobody asked about the second one.`;
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
  await page.getByRole('button', { name: 'Post question' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Graphinity isn’t responding' })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Your question')).toHaveValue(title);
  await page.unroute(questions);

  // Back online it posts, and the draft is gone.
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

test('answers that report amounts show how far they agree, and keep the odd one visible', async ({
  page,
  browserName,
}) => {
  const run = `${browserName}${String(Date.now() % 1_000_000)}`;
  const words = runWords(browserName);
  await signIn(page, 'Test person A');
  await setUpIfNeeded(page, `asker.${run}`);
  await establishTestPersonA();
  await page.goto('/ask');
  const title = `How much customs did you pay on a watch through Chennai, case ${words}?`;
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
    const handle = `amount${String(i)}.${run}`;
    await setUpIfNeeded(page, handle);
    // This test exercises aggregate answer presentation, not anti-abuse
    // throttling. Age each independently created author past the new-account
    // posting limit so the third claim can be submitted deterministically.
    await asOwner("UPDATE app.profiles SET created_at = now() - interval '30 days' WHERE handle = $1", [handle]);
    await page.goto(questionUrl);
    await page.getByLabel('Your answer').fill(body);
    await page.getByRole('button', { name: 'Post answer' }).click();
    await expect(page.getByText(body)).toBeVisible();
    await signOut(page);
  }

  await page.goto(questionUrl);
  await expect(page.getByRole('region', { name: '3 answers' })).toBeVisible();
  const summary = page.getByRole('region', { name: /agree|differ/ });
  await expect(summary).toBeVisible();
  await expect(summary).toContainText('₹95,000–₹96,000');
  await expect(summary).toContainText('₹1,40,000');
  const outlier = page.getByRole('listitem').filter({ hasText: 'Paid ₹1,40,000' });
  await expect(outlier.getByText('Different outcome · kept visible')).toBeVisible();
  await audit(page, 'question (answers agree in part)');
});

test('asking something already answered offers those answers first without blocking a related fallback', async ({
  page,
  browserName,
}) => {
  const run = `${browserName}${String(Date.now() % 1_000_000)}`;
  const words = runWords(browserName);
  const title = `Which documents did customs want for a used camera from Japan, case ${words}?`;
  // Someone asked it and got an answer.
  await signIn(page, 'A brand-new person');
  await setUpIfNeeded(page, `first.${run}`);
  await enableAIForThisTest(page);
  await page.goto('/ask');
  await page.getByLabel('Topic').selectOption('imports-customs');
  await page.getByLabel('Your question').fill(title);
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
  await setUpIfNeeded(page, `matcher.${run}`);
  await enableAIForThisTest(page);
  await establishTestPersonA();
  await page.goto('/ask');
  await page.getByLabel('Topic').selectOption('imports-customs');
  await page.getByLabel('Your question').fill(title);
  const card = page.getByRole('region', { name: 'This was asked and answered recently' });
  const matches = page.getByRole('region', { name: 'Similar questions already asked' });
  // Matching by meaning is on for everyone now (ADR 0015): the same question is offered first, in
  // the "asked and answered" card when it's a recent duplicate, otherwise in the similar list.
  const offered = card.or(matches);
  await expect(offered.first()).toBeVisible();
  await expect(offered.getByRole('link').filter({ hasText: title }).first()).toHaveAttribute(
    'href',
    new RegExp(`^${questionUrl.split('/').slice(0, 3).join('/')}`),
  );
  await audit(page, 'ask (already answered)');
  if (await card.isVisible()) {
    // Only confident, consented semantic matches may show the interruptive UI.
    await expect(page.getByRole('button', { name: 'Post question' })).toBeDisabled();
    await expect(page.getByText('Read the answers above, or say yours is different.')).toBeVisible();
    await card.getByRole('button', { name: 'Mine is different' }).click();
    await expect(card).toHaveCount(0);
  }
  // With lexical-only fallback, the match is suggested but never blocks a new post.
  await expect(page.getByRole('button', { name: 'Post question' })).toBeEnabled();
});

async function enableAIForThisTest(page: import('@playwright/test').Page) {
  await page.goto('/me/privacy');
  const category = page.getByRole('heading', { name: 'ai personalization' }).locator('..');
  const allow = category.getByRole('checkbox');
  if (!(await allow.isChecked())) await allow.click();
  await expect(allow).toBeChecked();
}
