// The welcome consent screen (ADR 0023): shown to a signed-in person while
// any optional use of their data is unanswered. Its three answers are equal
// in size, weight and contrast, each takes one tap, nothing is ticked in
// advance, and any answer ends it until a new purpose appears.
import { audit, clearConsoleErrors, expect, setUpIfNeeded, signIn, test } from './helpers.ts';
import type { Page } from '@playwright/test';

test.beforeEach(clearConsoleErrors);

const TITLE = 'Your data, your choice';
const ANSWERS = ['Essential only', 'Choose', 'Accept all'] as const;

async function reachScreen(page: Page, browserName: string, tag: string) {
  await signIn(page, 'A brand-new person');
  await setUpIfNeeded(page, `${tag}.${browserName}${String(Date.now() % 1_000_000)}`, { answerConsent: false });
  const sheet = page.getByRole('dialog', { name: TITLE });
  await expect(sheet).toBeVisible();
  return sheet;
}

/** Each answer's box, weight, and text contrast against the fill it sits on (composited in sRGB). */
async function measure(page: Page) {
  return page.evaluate(names => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('no canvas');
    // Paint colours in order (each may be translucent) and read the pixel the eye would see.
    const seen = (...colours: string[]) => {
      ctx.clearRect(0, 0, 1, 1);
      for (const c of colours) {
        ctx.fillStyle = c;
        ctx.fillRect(0, 0, 1, 1);
      }
      return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3);
    };
    const luminance = (rgb: number[]) => {
      const [r = 0, g = 0, b = 0] = rgb.map(v => {
        const s = v / 255;
        return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const dialog = document.querySelector('dialog[open] .dialog-panel');
    const panel = dialog?.querySelector(':scope > .sq-fill');
    if (!dialog || !panel) throw new Error('no dialog');
    const panelColour = getComputedStyle(panel).backgroundColor;
    return names.map(name => {
      const button = [...dialog.querySelectorAll('button')].find(b => b.textContent.trim() === name);
      if (!button) throw new Error(`no ${name}`);
      const box = button.getBoundingClientRect();
      const fill = button.querySelector('.sq-fill');
      const style = getComputedStyle(button);
      const label = button.querySelector('.btn-label');
      const bg = seen('#fff', panelColour, fill ? getComputedStyle(fill).backgroundColor : 'transparent');
      const text = seen(`rgb(${bg.join(',')})`, style.color);
      const [a, b] = [luminance(text), luminance(bg)].sort((x, y) => y - x);
      return {
        name,
        width: Math.round(box.width * 10) / 10,
        height: Math.round(box.height * 10) / 10,
        weight: getComputedStyle(label ?? button).fontWeight,
        size: getComputedStyle(label ?? button).fontSize,
        fill: bg.join(','),
        contrast: ((a ?? 0) + 0.05) / ((b ?? 0) + 0.05),
      };
    });
  }, ANSWERS);
}

test('gives its three answers equal size, weight and contrast, at every width, in light and dark', async ({
  page,
  browserName,
}) => {
  const sheet = await reachScreen(page, browserName, 'symmetry');
  await expect(sheet.getByText('stays off until you allow it')).toBeVisible();
  for (const width of [320, 375, 430, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      const [first, ...rest] = await measure(page);
      if (!first) throw new Error('no answers');
      expect(first.height, `${String(width)} ${scheme}: tall enough to tap`).toBeGreaterThanOrEqual(44);
      for (const other of rest) {
        const where = `${String(width)} ${scheme}: ${other.name} against ${first.name}`;
        expect(Math.abs(other.height - first.height), `${where}, height`).toBe(0);
        expect(Math.abs(other.width - first.width), `${where}, width`).toBeLessThanOrEqual(1);
        expect([other.weight, other.size, other.fill], `${where}, weight and fill`).toEqual([
          first.weight,
          first.size,
          first.fill,
        ]);
      }
      for (const a of [first, ...rest])
        expect(a.contrast, `${String(width)} ${scheme}: ${a.name} contrast`).toBeGreaterThanOrEqual(4.5);
    }
  }
  await page.emulateMedia({ colorScheme: 'light' });
  await page.setViewportSize({ width: 1280, height: 800 });
  await audit(page, 'consent welcome');
  // "Choose" shows every use, none ticked.
  await sheet.getByRole('button', { name: 'Choose' }).click();
  const boxes = sheet.getByRole('checkbox');
  expect(await boxes.count()).toBeGreaterThan(0);
  for (const box of await boxes.all()) await expect(box).not.toBeChecked();
  await audit(page, 'consent welcome, choosing');
});

for (const [answer, allowed] of [
  ['Essential only', false],
  ['Accept all', true],
] as const) {
  test(`records “${answer}” in one tap, and doesn’t ask again`, async ({ page, browserName }) => {
    const sheet = await reachScreen(page, browserName, answer === 'Accept all' ? 'accept' : 'essential');
    await sheet.getByRole('button', { name: answer }).click();
    await expect(sheet).toBeHidden();
    const asked = page.waitForResponse(r => new URL(r.url()).pathname === '/me/consents');
    await page.reload();
    const after = (await (await asked).json()) as {
      unanswered: string[];
      categories: Array<{ name: string; enabled: boolean; requiredForService: boolean }>;
    };
    expect(after.unanswered).toEqual([]);
    const optional = after.categories.filter(c => !c.requiredForService);
    expect(optional.length).toBeGreaterThan(0);
    for (const c of optional) expect(c.enabled, c.name).toBe(allowed);
    await expect(page.getByRole('link', { name: 'Ask a question' })).toBeVisible();
    await expect(sheet).toBeHidden();
  });
}

test('records Escape as “Essential only”', async ({ page, browserName }) => {
  const sheet = await reachScreen(page, browserName, 'escape');
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  const asked = page.waitForResponse(r => new URL(r.url()).pathname === '/me/consents');
  await page.reload();
  const after = (await (await asked).json()) as {
    unanswered: string[];
    categories: Array<{ enabled: boolean; requiredForService: boolean }>;
  };
  expect(after.unanswered).toEqual([]);
  expect(after.categories.filter(c => !c.requiredForService).every(c => !c.enabled)).toBe(true);
});
