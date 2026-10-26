// Reports and moderators.
import {
  asOwner,
  audit,
  clearConsoleErrors,
  establishTestPersonA,
  expect,
  readAsOwner,
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

test('a moderator reviews a group picking each other, and confirms it', async ({ page, browserName }) => {
  const run = `${browserName}${String(Date.now() % 1_000_000)}`;
  await signIn(page, 'Test person A');
  await setUpIfNeeded(page, `moderator.${run}`);
  await establishTestPersonA();
  await asOwner('INSERT INTO app.moderators (profile_id) VALUES ($1) ON CONFLICT DO NOTHING', [TEST_PERSON_A]);
  // Three people of its own, recorded as a group the way the daily job records one (ADR 0017).
  const people = await readAsOwner<{ id: string; handle: string }>(
    `WITH p AS (
       INSERT INTO app.profiles (id, handle, country, adult_confirmed_at)
       SELECT gen_random_uuid(), 'ring.' || $1 || '.' || n, 'IN', now() FROM generate_series(1, 3) AS n
       RETURNING id, handle
     ), f AS (INSERT INTO app.profile_fields (profile_id, field) SELECT id, 'travel' FROM p)
     SELECT id::text, handle FROM p`,
    [run],
  );
  expect(people).toHaveLength(3);
  await asOwner(
    `WITH g AS (
       INSERT INTO app.collusion_groups (member_key, members, inside, expected, lift)
       VALUES (md5(random()::text) || md5(random()::text), 3, 6, 0.2, 9999) RETURNING id)
     INSERT INTO app.collusion_members (group_id, profile_id) SELECT g.id, unnest($1::uuid[]) FROM g`,
    [people.map(p => p.id)],
  );
  await page.goto('/review');
  await expect(page.getByRole('heading', { name: 'Groups picking each other' })).toBeVisible();
  const handles = people.map(p => p.handle).sort();
  const group = page
    .getByRole('listitem')
    .filter({ hasText: `@${handles[0] ?? ''}, @${handles[1] ?? ''}` })
    .first();
  await expect(group).toContainText('6 picks among them');
  await audit(page, 'review with a group');
  await group.getByRole('button', { name: 'Collusion…' }).click();
  await expect(group.getByText('It can’t be undone.')).toBeVisible();
  await audit(page, 'review confirming a group');
  await group.getByRole('button', { name: 'Take back points' }).click();
  await expect(group.getByText(/^Confirmed\./)).toBeVisible();
  await expect(group.getByRole('button')).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('listitem').filter({ hasText: '9999 times more' })).toHaveCount(0);
});

test('a moderator sees whether Graphinity is working, and what needs attention', async ({ page, browserName }) => {
  const run = `${browserName}${String(Date.now() % 1_000_000)}`;
  await signIn(page, 'Test person A');
  await setUpIfNeeded(page, `moderator.${run}`);
  await establishTestPersonA();
  await asOwner('INSERT INTO app.moderators (profile_id) VALUES ($1) ON CONFLICT DO NOTHING', [TEST_PERSON_A]);
  // Some measured traffic, and every job working, the way the server records them (ADR 0020).
  await asOwner(
    `INSERT INTO app.ops_minutes (minute, method, route, requests, errors, slow, total_ms, buckets)
     VALUES (date_trunc('minute', now()) - interval '2 minutes', 'GET', '/questions/:id', 120, 0, 3, 4800,
             array_fill(0, ARRAY[30]))
     ON CONFLICT DO NOTHING`,
    [],
  );
  await asOwner("DELETE FROM app.ops_jobs WHERE job LIKE 'e2e-%' OR job = 'routing'", []);
  await asOwner(
    `INSERT INTO app.ops_jobs (job, expected_seconds, last_started_at, last_success_at, runs)
     VALUES ('routing', 60, now(), now(), 1)`,
    [],
  );
  await page.goto('/me');
  await page.getByRole('link', { name: 'Operations' }).click();
  await expect(page.getByRole('heading', { name: 'Operations', level: 1 })).toBeVisible();
  await expect(page.getByText('Everything is working within its objectives.')).toBeVisible();
  await expect(page.getByRole('listitem').filter({ hasText: 'Sending questions to people' })).toContainText('Worked');
  await audit(page, 'operations');

  // A job that failed: said plainly, with what to do.
  await asOwner(
    `UPDATE app.ops_jobs SET last_failure_at = now(), last_error_kind = 'TimeoutError', failures = 1 WHERE job = 'routing'`,
    [],
  );
  await page.reload();
  await expect(page.getByText('Sending questions to people: failed just now (TimeoutError).')).toBeVisible();
  await audit(page, 'operations with a problem');
  await asOwner("UPDATE app.ops_jobs SET last_failure_at = NULL, last_error_kind = NULL WHERE job = 'routing'", []);
});
