import { asOwner, audit, expect, setUpIfNeeded, signIn, signOut, test } from './helpers.ts';

test('a routed question can be passed and restored during the seven-second undo window', async ({
  page,
  browserName,
}) => {
  const run = `${browserName}.${String(Date.now() % 1_000_000)}`;
  const handleRun = String(Date.now() % 1_000_000);
  const title = `A routed customs question ${run}?`;

  await signIn(page, 'A brand-new person');
  await setUpIfNeeded(page, `route.asker.${handleRun}`);
  await page.getByRole('link', { name: 'Ask a question' }).click();
  await page.getByLabel('Your question').fill(title);
  await page.getByLabel('Topic').selectOption('imports-customs');
  await page.getByRole('button', { name: 'Post question' }).click();
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
  await signOut(page);

  await signIn(page, 'A brand-new person');
  const recipient = `route.recipient.${handleRun}`;
  await setUpIfNeeded(page, recipient);
  await asOwner(
    `INSERT INTO app.routes (question_id, profile_id, wave)
     SELECT q.id, p.id, 1 FROM app.questions q CROSS JOIN app.profiles p
     WHERE q.title = $1 AND p.handle = $2 ON CONFLICT DO NOTHING`,
    [title, recipient],
  );

  await page.goto('/');
  const inbox = page.getByRole('region', { name: 'Asked of you' });
  await expect(inbox.getByRole('link', { name: new RegExp(title) })).toBeVisible();
  await audit(page, 'routed question inbox');
  await inbox.getByRole('button', { name: 'Pass' }).click();
  await expect(inbox.getByRole('status')).toContainText('You can undo for 7 seconds.');
  await inbox.getByRole('button', { name: 'Undo' }).click();
  await expect(inbox.getByRole('link', { name: new RegExp(title) })).toBeVisible();
});
