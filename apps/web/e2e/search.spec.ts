// Search (ADR 0015 part 4): from the home page to a result and back, with what
// is recorded to improve search only for someone who allowed it.
import { asOwner, clearConsoleErrors, expect, readAsOwner, setUpIfNeeded, signIn, test } from './helpers.ts';

test.beforeEach(clearConsoleErrors);

test('searches from home, opens a result, and records the reading only when allowed', async ({ page, browserName }) => {
  const word = `harmonium${browserName}${String(Date.now() % 1_000_000)}`;
  await signIn(page, 'A brand-new person');
  const handle = `finder.${browserName}${String(Date.now() % 1_000_000)}`;
  await setUpIfNeeded(page, handle, { answerConsent: false });
  const consent = page.getByRole('dialog', { name: 'Your data, your choice' });
  await consent.getByRole('button', { name: 'Choose' }).click();
  await consent.getByRole('checkbox', { name: /^Search improvement/ }).check();
  await consent.getByRole('button', { name: 'Save choices' }).click();
  await expect(consent).toBeHidden();
  // A question with a word nobody else uses, asked by this person (a new account may ask 3 a day).
  await asOwner(
    `INSERT INTO app.questions (asker_id, field, title)
     SELECT id, 'imports-customs', $1 FROM app.profiles WHERE handle = $2`,
    [`Shipping a ${word} from Kolkata: which courier?`, handle],
  );
  const urls: string[] = [];
  page.on('framenavigated', f => urls.push(f.url()));

  await page.goto('/');
  const field = page.getByRole('searchbox', { name: 'Search questions' });
  await field.fill(word);
  await field.press('Enter');
  await expect(page).toHaveURL(/\/search$/);
  const result = page.getByRole('link', { name: new RegExp(word) });
  await expect(result).toBeVisible();
  await expect(page.getByText(/^Has all your words/)).toBeVisible();
  await result.click();
  await expect(page.getByRole('heading', { name: new RegExp(word), level: 1 })).toBeVisible();
  await page.waitForTimeout(1_200);
  await page.getByRole('button', { name: 'Back' }).click();
  // Back on the same results, kept for this tab.
  await expect(page.getByRole('link', { name: new RegExp(word) })).toBeVisible();
  // The search never appeared in an address (a question's own address carries its title).
  for (const u of urls.filter(u => !new URL(u).pathname.startsWith('/q/'))) expect(u).not.toContain(word);

  const recorded = async () =>
    readAsOwner<{ query: string; opened: boolean; dwell: number | null }>(
      `SELECT s.query, o.opened_at IS NOT NULL AS opened, o.dwell_ms AS dwell
       FROM app.searches s JOIN app.profiles p ON p.id = s.user_id
       LEFT JOIN app.search_opens o ON o.search_id = s.id
       WHERE p.handle = $1`,
      [handle],
    );
  await expect.poll(async () => (await recorded())[0]?.dwell ?? 0, { timeout: 5_000 }).toBeGreaterThanOrEqual(1_000);
  const rows = await recorded();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ query: word, opened: true });

  // Signing out forgets the last search: the next person on this device doesn't see it.
  // Within the app, as a person does it (a page load would forget it anyway).
  await page.getByRole('link', { name: /^Your profile/ }).click();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeVisible();
  // Signing out ends by going home: wait for it, or it could land after the next step.
  await expect(page).toHaveURL(/\/$/);
  await page.evaluate(() => {
    history.pushState(null, '', '/search');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  await expect(page.getByRole('heading', { name: 'Search', level: 1 })).toBeVisible();
  await expect(page.getByRole('link', { name: new RegExp(word) })).toHaveCount(0);
  await expect(page.getByRole('searchbox', { name: 'Search questions' })).toHaveValue('');
});
