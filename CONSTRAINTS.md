# Constraints

The quality bar for Graphinity, with numbers. Every number has a reason and a command that checks
it. **Do not weaken this file to make a change pass.** Tightening is fine; loosening needs the
owner's agreement in the commit message, and the floor guard flags any changed number.

Last reviewed: 2026-10-18 (Phase 0 audit). Owner: Chiranjeevi560.

Choices behind it (from the owner's brief): enforce everything the audit prompt lists; failing
checks **block**; where no industry number exists, **measure today and refuse to get worse**
(ratchet, 0.5% tolerance); fast checks while working, slow ones at task end and in CI.

## Floor (always enforced)

Checked by `node scripts/floor-guard.mjs` on everything changed since `origin/main`.

- No new suppression comments: `@ts-ignore`, `@ts-nocheck`, `@ts-expect-error`, `eslint-disable`,
  coverage-ignore comments, `nosemgrep`, `gitleaks:allow`.
- No unfinished work: "not implemented" stubs, empty `catch {}`, `TODO`, `FIXME`.
- No tests made easier: `.skip`, `.only`, `.todo`, `.fixme`, deleted test files, assertions removed
  from tests that stayed. An assertion replaced because the behaviour it checked changed on purpose
  needs a reason in the commit: `Assertions-changed: <at least ten characters of why>`.
- No secrets in source (gitleaks, below).
- No changed numbers or new exceptions in this file without the owner's say-so.

## Enforced with numbers

| Dimension | Rule | Why this number | Checked by | Runs at |
|---|---|---|---|---|
| Types | Zero errors, TypeScript strict | Types are free correctness | `npm run typecheck` | every edit |
| Lint | Zero findings (type-aware rules, React hooks, jsx-a11y strict) | No suppression file and no disable comments (the floor guard blocks new ones) | `npm run lint` | every edit |
| Floor | Clean | See above | `node scripts/floor-guard.mjs` | every edit |
| Unit and integration tests | All pass; integration tests run on real Postgres as the restricted role | Tests that skip on missing setup prove nothing | `npm test` | task end, CI |
| Coverage, server | Lines ≥ 90.36%, branches ≥ 86.15% (today) | Ratchet: hold today's line; the run fails 0.5 points below it | `npm run test:coverage` (thresholds in `apps/api/vitest.config.ts`) | task end, CI |
| Coverage, website (unit) | Lines ≥ 47.77% (today) | Ratchet; the run fails 0.5 points below it. Screens are covered by browser tests instead | `npm run test:coverage` (thresholds in `apps/web/vitest.config.ts`) | task end, CI |
| Accessibility | Zero serious or critical axe findings (WCAG 2.2 AA) on every screen, light and dark | WCAG AA is the legal and moral minimum. External judge | `npm run test:e2e` | task end, CI |
| Layout | No sideways scrolling at 320, 375, 430, 1280 px on any screen | Owner's rule | `npm run test:e2e` | task end, CI |
| Tap targets | ≥ 44 px (inline text links exempt, per WCAG 2.5.8) | Apple's minimum | `npm run test:e2e` | task end, CI |
| Browser errors | Zero console errors or CSP violations (expected 404s aside) | A CSP violation means something was blocked | `npm run test:e2e` | task end, CI |
| Engines | Chromium and WebKit locally; plus Firefox in CI | Firefox won't start on macOS 27 (see Known limits) | `npm run test:e2e`, CI | task end, CI |
| Page speed | Lighthouse mobile: performance ≥ 95, accessibility 100, best practices 100, SEO 100, LCP ≤ 2500 ms, CLS ≤ 0.1, TBT ≤ 200 ms | LCP/CLS are Google's "good" thresholds; 95 holds today's 99 with room for noise | `npm run check:perf` | task end, CI |
| Bundle size (brotli) | Main script ≤ 61.80 kB, styles ≤ 5.95 kB, all scripts ≤ 95.99 kB | Ratchet: today + 0.5%. Growth must be a decision | `npm run check:size` | task end, CI |
| Secrets | No findings in git history or uncommitted changes (values always redacted) | External judge | `npm run check:secrets` | task end, CI |
| Dependencies | Nothing known-vulnerable at high or above | External database (OSV) | `npm run check:deps` | task end, CI |
| Code security | No Semgrep findings at ERROR (p/default, p/owasp-top-ten, p/typescript, p/react) | External rules | CI only (`semgrep`) | CI |
| Supply chain | Exact versions, lockfile, install scripts off, nothing published in the last 2 weeks, CI actions pinned to commits | Owner's brief | review, `.npmrc`, CI | every change |

One command per stage: `npm run check:fast` (seconds), `npm run check:task` (about a minute),
`npm run check:full` (several minutes, includes browsers and Lighthouse).

## Measured, not yet enforced

| Metric | Today | Direction |
|---|---|---|
| Lighthouse best practices, missing-profile page | 96 (logged 404) | must not fall |

## Exceptions

| ID | Rule | Path | Reason | Owner | Expires |
|---|---|---|---|---|---|

None open.

## Known limits of the checks

- Firefox (Playwright build) exits with "Could not find profile folder" on this Mac (macOS 27.0.1),
  with or without the command sandbox, so Firefox runs in CI on Linux only.
- Homebrew has no bottles for macOS 27: gitleaks and osv-scanner are the projects' official release
  binaries in `.local/tools/`, verified against their published SHA-256 checksums. Semgrep runs in
  CI only, from its official Docker image pinned by digest.
- Locally, the preview server drops `upgrade-insecure-requests` from the CSP (WebKit upgrades even
  localhost to https). Deploys keep it; a test checks both.
- The `Constraints-approved:` and `Assertions-changed:` trailers are honour-based: the guard can't
  tell who wrote them. The owner can audit them with
  `git log --grep='Constraints-approved\|Assertions-changed'`. A new exception is approved by its ID
  (`Constraints-approved: E3`); a changed number by its whole row name, one trailer per row
  (`Constraints-approved: Coverage, server`).
- The guard flags any changed number on a row, tightening included. It can't tell a maximum from a
  minimum on the same row, and a wrong guess would let a loosening through silently.
- The project's own tests are the circular kind of check. The external judges are axe, Lighthouse,
  osv-scanner, npm audit, gitleaks and Semgrep.
