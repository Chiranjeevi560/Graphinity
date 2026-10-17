// Walks every screen built so far, the way a person would, and measures each
// one against the quality bar: accessibility (axe, WCAG 2.2 AA) in light and
// dark, sideways scrolling at phone and desktop widths, tap target sizes,
// console errors and Content-Security-Policy violations.
//
// Findings are soft assertions: every problem on every screen is reported in
// one run, instead of stopping at the first.
import { mkdirSync, writeFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const WIDTHS = [320, 375, 430, 1280];
const MIN_TARGET = 44;

interface ScreenReport {
  screen: string;
  axe: Array<{ scheme: string; id: string; impact: string | null | undefined; nodes: number; help: string; where: string[] }>;
  overflow: number[];
  smallTargets: Array<{ width: number; label: string; w: number; h: number }>;
}

const reports: ScreenReport[] = [];
const consoleErrors: string[] = [];

async function settle(page: Page) {
  await page.waitForLoadState('networkidle');
  // Wait out route fades so contrast is measured on final colours.
  await page.waitForFunction(() => document.getAnimations().every(a => a.playState !== 'running'));
}

async function audit(page: Page, screen: string) {
  const report: ScreenReport = { screen, axe: [], overflow: [], smallTargets: [] };
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await settle(page);
    const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
    for (const v of result.violations) {
      report.axe.push({
        scheme, id: v.id, impact: v.impact, nodes: v.nodes.length, help: v.help,
        // Which element, and axe's own one-line reason (it includes the measured ratio).
        where: v.nodes.map(n => `${n.target.join(' ')} :: ${(n.failureSummary ?? '').split('\n').slice(1).join(' ').slice(0, 160)}`),
      });
    }
  }
  await page.emulateMedia({ colorScheme: 'light' });
  const original = page.viewportSize();
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 800 });
    await settle(page);
    const { overflow, small } = await page.evaluate((min) => {
      const overflow = document.documentElement.scrollWidth > window.innerWidth;
      const small: Array<{ label: string; w: number; h: number }> = [];
      for (const el of document.querySelectorAll<HTMLElement>('a, button, input, select, textarea, [role="button"], label.checkbox')) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        // Links inside running text are exempt (WCAG 2.5.8 "inline").
        if (el.tagName === 'A' && el.closest('p')) continue;
        // A visually hidden native checkbox is covered by its 44px label row.
        if (el instanceof HTMLInputElement && el.type === 'checkbox' && el.closest('label.checkbox')) continue;
        if (Math.min(r.width, r.height) < min) {
          small.push({ label: (el.getAttribute('aria-label') ?? el.textContent).trim().slice(0, 40), w: Math.round(r.width), h: Math.round(r.height) });
        }
      }
      return { overflow, small };
    }, MIN_TARGET);
    if (overflow) report.overflow.push(width);
    for (const s of small) report.smallTargets.push({ width, ...s });
  }
  if (original) await page.setViewportSize(original);
  reports.push(report);
  // Saved after every screen, so a later failure can't hide earlier findings.
  mkdirSync('test-results', { recursive: true });
  writeFileSync(`test-results/audit-${test.info().project.name}.json`, JSON.stringify({ reports, consoleErrors }, null, 2));

  expect.soft(report.axe.filter(v => v.impact === 'critical' || v.impact === 'serious'), `${screen}: serious accessibility problems`).toEqual([]);
  expect.soft(report.overflow, `${screen}: sideways scrolling at these widths`).toEqual([]);
  expect.soft(report.smallTargets, `${screen}: tap targets under ${MIN_TARGET}px`).toEqual([]);
}

test('every screen meets the bar', async ({ page, browserName }, testInfo) => {
  page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(`${page.url()} :: ${msg.text().slice(0, 200)}`); });
  page.on('pageerror', err => consoleErrors.push(`${page.url()} :: pageerror ${err.message.slice(0, 200)}`));

  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await audit(page, 'home (signed out)');

  await page.goto('/this/does/not/exist');
  await audit(page, 'not found');

  await page.goto('/u/nobody.here');
  await expect(page.getByText('There’s no one with that name.')).toBeVisible();
  await audit(page, 'public profile (missing)');

  // Sign in through the local stand-in.
  await page.goto('/');
  await page.getByRole('button', { name: 'Continue with Google' }).click();
  await page.getByRole('button', { name: 'A brand-new person' }).click();
  await expect(page).toHaveURL(/\/welcome$/);
  await audit(page, 'welcome 1: name (empty)');

  const handle = `audit.${browserName}.${Date.now() % 1_000_000}`;
  await page.getByLabel('Name').fill(handle);
  await expect(page.getByText('Available')).toBeVisible();
  await audit(page, 'welcome 1: name (available)');
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(page.getByRole('heading', { name: 'Where do you live?' })).toBeVisible();
  await page.getByLabel('Country').selectOption('IN');
  await audit(page, 'welcome 2: country');
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(page.getByRole('heading', { name: 'What do you know about?' })).toBeVisible();
  await page.getByRole('button', { name: 'Imports & Customs' }).click();
  await page.getByText('I’m 18 or older').click();
  await audit(page, 'welcome 3: fields');
  await page.getByRole('button', { name: 'Create profile' }).click();

  await expect(page.getByText(`@${handle}`)).toBeVisible();
  await audit(page, 'home (signed in)');

  await page.goto('/me');
  await expect(page.getByRole('heading', { name: `@${handle}` })).toBeVisible();
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

  await page.goto('/me');
  await page.getByRole('button', { name: 'Delete account…' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete account' }).click();
  await expect(page.getByRole('heading', { name: 'Your account is deleted' })).toBeVisible();
  await audit(page, 'goodbye');

  // CSP violations surface as console errors in every engine.
  expect.soft(consoleErrors.filter(e => !e.includes('404')), 'console errors').toEqual([]);
  await testInfo.attach(`audit-${browserName}.json`, { body: JSON.stringify({ reports, consoleErrors }, null, 2), contentType: 'application/json' });
});
