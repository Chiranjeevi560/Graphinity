// The one-time privacy update (ADR 0015): shown once to a signed-in person,
// meets the bar like any screen, and any answer ends it for good.
import { audit, clearConsoleErrors, expect, setUpIfNeeded, signIn, test } from './helpers.ts';

test.beforeEach(clearConsoleErrors);

test('asks once, and never again after an answer', async ({ page, browserName }) => {
  await signIn(page, 'A brand-new person');
  await setUpIfNeeded(page, `update.${browserName}${String(Date.now() % 1_000_000)}`, { answerPrivacyUpdate: false });
  const sheet = page.getByRole('dialog', { name: 'Two privacy updates' });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText('Nothing is sent to an outside AI.')).toBeVisible();
  await expect(sheet.getByText('Help improve search for everyone?')).toBeVisible();
  await audit(page, 'privacy update');
  await sheet.getByRole('button', { name: 'Allow' }).click();
  await expect(sheet).toBeHidden();
  // Recorded: a reload doesn't bring it back.
  const asked = page.waitForResponse(r => new URL(r.url()).pathname === '/me/consents');
  await page.reload();
  const after = (await (await asked).json()) as {
    awaitingAnswer: string[];
    categories: Array<{ name: string; enabled: boolean }>;
  };
  expect(after.awaitingAnswer).toEqual([]);
  // "Allow" was recorded as allowed: closing the sheet afterwards isn't a second answer.
  expect(after.categories.find(c => c.name === 'search_improvement')?.enabled).toBe(true);
  await expect(page.getByRole('link', { name: 'Ask a question' })).toBeVisible();
  await expect(sheet).toBeHidden();
});
