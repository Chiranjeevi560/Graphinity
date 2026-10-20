// The home graph: alive, still for people who turn motion off, and explorable by keyboard.
import { audit, clearConsoleErrors, expect, test } from './helpers.ts';

test.beforeEach(clearConsoleErrors);

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
