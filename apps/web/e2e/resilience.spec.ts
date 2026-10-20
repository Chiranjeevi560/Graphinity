// When Graphinity or the connection is down: what people are told, and how pages recover.
import { audit, clearConsoleErrors, consoleErrors, expect, test } from './helpers.ts';

test.beforeEach(clearConsoleErrors);

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
