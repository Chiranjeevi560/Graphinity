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

// In GitHub Actions, a failure before anything is measured (a busy port, a
// server or browser that won't start) also shows on the run and its pull
// request, not only in the log.
const annotate = message => {
  if (process.env.GITHUB_ACTIONS)
    console.log(`::error title=Page speed could not run::${message.replace(/\r?\n/g, ' ')}`);
};
process.on('uncaughtException', err => {
  annotate(err instanceof Error ? `${err.message} ${err.stack?.split('\n')[1]?.trim() ?? ''}` : String(err));
  throw err;
});

// Keep in step with CONSTRAINTS.md.
const BUDGET = { performance: 95, accessibility: 100, bestPractices: 100, seo: 100, lcpMs: 2500, cls: 0.1, tbtMs: 200 };
const PAGES = ['/'];

// Measuring whatever already listens on these ports would give someone
// else's numbers (an old build, a dev server): refuse instead.
for (const url of ['http://localhost:4174/', 'http://localhost:3000/health']) {
  const busy = await fetch(url).then(
    () => true,
    () => false,
  );
  if (busy) {
    const message = `Something is already running at ${new URL(url).host}. Stop it, then run this again.`;
    console.error(message);
    annotate(message);
    process.exit(1);
  }
}

// The same neutral build as any deploy, stamped for the address it is
// measured at, so canonical links point home.
execFileSync('npm', ['--workspace', 'apps/web', 'run', 'build'], { stdio: 'ignore' });
execFileSync('node', ['stamp-dist.ts', 'dist', 'dist-local', '--local'], {
  cwd: 'apps/web',
  stdio: 'inherit',
  env: { ...process.env, VITE_SITE_ORIGIN: 'http://localhost:4174' },
});
const preview = spawn('npx', ['vite', 'preview', '--outDir', 'dist-local', '--port', '4174', '--strictPort'], {
  cwd: 'apps/web',
  stdio: 'ignore',
});
// The real API too (it needs the local database, or CI's): the home page
// loads recent questions, and a page measured without its API logs errors
// no visitor would see.
const api = spawn('node', ['--env-file=.local/api.env', 'apps/api/src/main.ts'], {
  stdio: 'ignore',
  env: { ...process.env, PORT: '3000', WEB_ORIGIN: 'http://localhost:4174' },
});
const waitFor = async url => {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(200);
  }
  throw new Error(`${url} did not start`);
};
let failed = false;
try {
  await waitFor('http://localhost:4174/');
  await waitFor('http://localhost:3000/health');
  const chrome = await chromeLauncher.launch({
    chromePath: chromium.executablePath(),
    chromeFlags: ['--headless=new'],
  });
  try {
    for (const page of PAGES) {
      const { lhr } = await lighthouse(`http://localhost:4174${page}`, {
        port: chrome.port,
        output: 'json',
        logLevel: 'error',
        onlyCategories: ['performance', 'accessibility', 'best-practices', 'seo'],
      });
      const score = k => Math.round(lhr.categories[k].score * 100);
      const lcp = lhr.audits['largest-contentful-paint'].numericValue;
      const cls = lhr.audits['cumulative-layout-shift'].numericValue;
      const tbt = lhr.audits['total-blocking-time'].numericValue;
      const misses = [];
      if (score('performance') < BUDGET.performance)
        misses.push(`performance ${score('performance')} < ${BUDGET.performance}`);
      if (score('accessibility') < BUDGET.accessibility)
        misses.push(`accessibility ${score('accessibility')} < ${BUDGET.accessibility}`);
      if (score('best-practices') < BUDGET.bestPractices)
        misses.push(`best practices ${score('best-practices')} < ${BUDGET.bestPractices}`);
      if (score('seo') < BUDGET.seo) misses.push(`SEO ${score('seo')} < ${BUDGET.seo}`);
      if (lcp > BUDGET.lcpMs) misses.push(`LCP ${Math.round(lcp)}ms > ${BUDGET.lcpMs}ms`);
      if (cls > BUDGET.cls) misses.push(`CLS ${cls.toFixed(3)} > ${BUDGET.cls}`);
      if (tbt > BUDGET.tbtMs) misses.push(`TBT ${Math.round(tbt)}ms > ${BUDGET.tbtMs}ms`);
      const line = `${page}  performance ${score('performance')}  accessibility ${score('accessibility')}  best-practices ${score('best-practices')}  seo ${score('seo')}  LCP ${Math.round(lcp)}ms  CLS ${cls.toFixed(3)}  TBT ${Math.round(tbt)}ms`;
      console.log(line);
      // In GitHub Actions, the numbers also show on the run and its pull request, readable
      // without the run's log (which only the owner can open).
      if (process.env.GITHUB_ACTIONS) console.log(`::${misses.length ? 'error' : 'notice'} title=Page speed::${line}`);
      if (misses.length) {
        failed = true;
        console.error(`  over budget: ${misses.join('; ')}`);
        if (process.env.GITHUB_ACTIONS) console.log(`::error title=Page speed over budget::${misses.join('; ')}`);
        // Name the checks that cost points, so the fix doesn't start with a guess.
        for (const key of ['best-practices', 'seo', 'accessibility']) {
          for (const ref of lhr.categories[key].auditRefs) {
            const audit = lhr.audits[ref.id];
            if (ref.weight > 0 && audit.score !== null && audit.score < 1)
              console.error(`  ${key}: ${ref.id} (${audit.title})`);
          }
        }
      }
    }
  } finally {
    await chrome.kill();
  }
} finally {
  preview.kill();
  api.kill();
}
process.exit(failed ? 1 : 0);
