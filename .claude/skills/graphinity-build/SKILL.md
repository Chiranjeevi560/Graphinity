---
name: graphinity-build
description: The one pipeline for any Graphinity work (feature, fix, screen, schema, review). Combines the project's chosen skills into stages with their essential rules, and says when to load each full skill. Use it first, every time.
---

# Building Graphinity like Apple or Google would

The bar: a person using Graphinity should never be able to tell it was built by one person with an
AI. It works the first time, feels calm and fast, protects their privacy by default, and can't be
gamed. Engineering that a reviewer at Apple or Google would sign off on.

Read `CLAUDE.md` and `CONSTRAINTS.md` first. They are the law; this is the method.

## The pipeline

Run the stages in order. A stage names the full skill to load when the work is more than routine;
the bullet points are the parts of it that always apply.

### 1. Understand (skills: `spec-driven-development`, `planning-and-task-breakdown`, `ponytail`)
- Read every file the change touches and trace the real flow end to end before choosing anything.
- Write the spec in 5-10 lines: what it does, the rules, what's out of scope. Defaults from
  `docs/PLAN.md`; anything that isn't there and is the owner's call (money, accounts, legal,
  product taste with no precedent) is the only reason to ask.
- Smallest thing that fully meets the bar: reuse what's in the repo, then the platform, then the
  installed dependencies. No speculative features, no new dependency for a few lines of code.

### 2. Design (skills: `apple-design`, `emil-design-eng`, `frontend-ui-engineering`, `api-and-interface-design`)
- Screens: system font, tokens from `tokens.css` only, rem units, 44pt targets, hairlines,
  squircles, light and dark from the start, plain words (what happened, what to do; never "Oops"),
  one primary action per screen, nothing that looks templated.
- Motion only where it explains a change; springs from `spring.ts`; respect reduced motion.
- APIs: `{ error, message }` refusals in plain words; schemas refuse unknown fields; ids as text;
  never an account id or an email in a response.
- Data: every rule repeated in the database (constraint, policy or trigger); RLS forced; only the
  columns the API needs are granted.

### 3. Doubt, before building anything sensitive (skill: `doubt-driven-development`)
Points, trust, routing, sign-in, permissions, moderation, anything money-like or privacy-like:
- Write the claim; give a fresh reviewer (Agent tool) only the artifact and the contract, with the
  adversarial prompt. Classify every finding (contract misread / fix / trade-off / noise), fix,
  repeat on the concrete code; stop at 3 cycles. Record accepted trade-offs in `SECURITY.md`.
- Offer the owner a cross-model review; if they've asked not to be interrupted, say it was skipped.

### 4. Build (skills: `incremental-implementation`, `test-driven-development`, `source-driven-development`, `security-and-hardening`)
- Facts about any library or service come from its own docs or source, never memory.
- Tests through the real server and a real Postgres (`test/helpers/app.ts`, `database.ts`). Write
  attacks, not just happy paths: another user, the database directly as `app_api`, concurrency,
  temp tables, isolation levels, deleted accounts.
- Every rule that matters: break it on purpose, watch its test fail, restore it (mutation). A
  rule with no failing test isn't done. If a mutation survives, the test is wrong: fix the test.
- Test fidelity: the test schema owner is a non-superuser that bypasses RLS and is a
  non-inheriting `app_api` member, like Supabase's `postgres`. Don't weaken that to pass a test.
- `.ts` imports, strict types, no suppressions, no `!`; lint findings are fixed, never silenced.

### 5. Verify (skills: `verification-before-completion`, `browser-testing-with-devtools`, `performance-optimization`)
- `npm run check:task`, then the browser audit in both engines (`npm run test:e2e`), and
  `AUDIT_SHOTS=1` screenshots of every changed screen, looked at by eye in light and dark.
- New screens go into `apps/web/e2e/screens.spec.ts` (or their journey's file), each through `audit()` from
  `helpers.ts`, so axe, widths 320-1280 and tap targets run on them.
- `npm run check:perf` (Lighthouse 95+/100/100/100), `check:size` (raise a budget only by the
  ratchet rule, with the reason in the commit), `check:secrets`, `check:deps`.
- Say plainly what wasn't verified (real phones, Supabase itself, the deploy).

### 6. Ship (skills: `code-review-and-quality`, `git-workflow-and-versioning`)
- Review your own diff for the five cleanup and correctness angles before committing.
- One concern per commit. Message: what was wrong, the cause with evidence, the fix, what was
  verified and what wasn't. Trailers: `Constraints-approved:` (budgets, with the reason),
  `Assertions-changed:` (a rewritten assertion, with why it's equal or stronger).
- Commit and push only through the gate script that pushes only if every check passed. Never pipe
  a check into `tail`, never chain a push with `;`.

### 7. Report (skill: `documentation-and-adrs`)
- Docs updated in the same commit: API, SECURITY, ENVIRONMENT, RUNBOOK, PLAN, SETUP-ACCOUNTS, LAUNCH.
- Tell the owner in plain words: what now works, what wasn't verified, and only the decisions or
  account steps that are truly theirs, with click-by-click steps.

## Lessons this project paid for

- A superuser test owner hid every owner-side policy mistake. Match production roles in tests.
- On Postgres 16+, whoever creates a role becomes a member of it: never write policies as "anyone
  not in app_api".
- `pg_trigger_depth()` is no proof a change came from a cascade; check the role it runs as.
- Count-then-insert limits need a lock; READ COMMITTED must be enforced where counts matter.
- A live stream makes "network idle" never come; measure "nothing but the stream is loading".
- Fastify `onClose` waits for open requests: end long-lived streams in `preClose`.
- Measure pages the way visitors see them (Lighthouse with the API running).
- Mobile carriers put many people behind one address: per-address limits must be generous.

## Not for this project
`omni-*`, `cli-*`, `ckm:slides`, `ckm:banner-design`, `write-swift`, `animate-expo` (until the
native app). Never install a skill or package from an unknown source without asking the owner.
