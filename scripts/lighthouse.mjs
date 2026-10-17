#!/usr/bin/env node
// Measures the production build with Google's Lighthouse on a simulated
// mid-range phone, and fails if it misses the budgets in CONSTRAINTS.md.
// Builds the site, serves it, measures, stops the server.
//
//   npm run check:perf
import { execFileSync, spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';
import lighthouse from 'lighthouse';
import * as chromeLauncher from 'chrome-launcher';

// Keep in step with CONSTRAINTS.md.
const BUDGET = { performance: 95, accessibility: 100, lcpMs: 2500, cls: 0.1, tbtMs: 200 };
const PAGES = ['/'];

execFileSync('npm', ['--workspace', 'apps/web', 'run', 'build'], { stdio: 'ignore' });
const preview = spawn('npx', ['vite', 'preview', '--port', '4174', '--strictPort'], { cwd: 'apps/web', stdio: 'ignore' });
let failed = false;
try {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch('http://localhost:4174/')).ok) break; } catch { /* not up yet */ }
    await sleep(200);
  }
  const chrome = await chromeLauncher.launch({ chromePath: chromium.executablePath(), chromeFlags: ['--headless=new'] });
  try {
    for (const page of PAGES) {
      const { lhr } = await lighthouse(`http://localhost:4174${page}`, {
        port: chrome.port, output: 'json', logLevel: 'error', onlyCategories: ['performance', 'accessibility', 'best-practices', 'seo'],
      });
      const score = k => Math.round(lhr.categories[k].score * 100);
      const lcp = lhr.audits['largest-contentful-paint'].numericValue;
      const cls = lhr.audits['cumulative-layout-shift'].numericValue;
      const tbt = lhr.audits['total-blocking-time'].numericValue;
      const misses = [];
      if (score('performance') < BUDGET.performance) misses.push(`performance ${score('performance')} < ${BUDGET.performance}`);
      if (score('accessibility') < BUDGET.accessibility) misses.push(`accessibility ${score('accessibility')} < ${BUDGET.accessibility}`);
      if (lcp > BUDGET.lcpMs) misses.push(`LCP ${Math.round(lcp)}ms > ${BUDGET.lcpMs}ms`);
      if (cls > BUDGET.cls) misses.push(`CLS ${cls.toFixed(3)} > ${BUDGET.cls}`);
      if (tbt > BUDGET.tbtMs) misses.push(`TBT ${Math.round(tbt)}ms > ${BUDGET.tbtMs}ms`);
      console.log(`${page}  performance ${score('performance')}  accessibility ${score('accessibility')}  best-practices ${score('best-practices')}  seo ${score('seo')}  LCP ${Math.round(lcp)}ms  CLS ${cls.toFixed(3)}  TBT ${Math.round(tbt)}ms`);
      if (misses.length) { failed = true; console.error(`  over budget: ${misses.join('; ')}`); }
    }
  } finally {
    await chrome.kill();
  }
} finally {
  preview.kill();
}
process.exit(failed ? 1 : 0);
