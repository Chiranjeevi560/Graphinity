// Reports and moderators.
import {
  asOwner,
  audit,
  clearConsoleErrors,
  establishTestPersonA,
  expect,
  runWords,
  setUpIfNeeded,
  signIn,
  signOut,
  test,
  TEST_PERSON_A,
} from './helpers.ts';

test.beforeEach(clearConsoleErrors);

test('a moderator removes a reported question', async ({ page, browserName }) => {
  const run = `${browserName}${String(Date.now() % 1_000_000)}`;
  const words = runWords(browserName);
  // Someone new asks something that shouldn't be there.
  await signIn(page, 'A brand-new person');
  await setUpIfNeeded(page, `spammer.${run}`);
  await page.goto('/ask');
  const title = `Cheap watches here, visit my shop now, case ${words}?`;
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
