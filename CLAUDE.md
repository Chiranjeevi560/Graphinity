# Graphinity

Ask once. Reach people who've actually done it. A global graph of people: a question is routed to
the people most likely to have lived experience of it, and the asker picks the answer that helped.
Full product decisions: `docs/PLAN.md`. Status of each build step is marked there.

The owner is a solo founder and CSE student, not a working engineer. Explain in plain words,
simply but completely. Ask questions as if to an everyday user. The bar is "as if Apple or Google
built it": never ship anything that looks or behaves like generic AI output.

**For any task, run the `graphinity-build` skill first** (`.claude/skills/graphinity-build`): it
is every chosen skill combined into one pipeline, with the bar and the lessons this project paid
for. **Read `CONSTRAINTS.md` before writing code. Do not weaken it to make a change pass.** Run
`npm run check:fast` after edits and `npm run check:task` before saying a task is done. Commit and
push only with `sh scripts/ship.sh <message-file> <paths…>`, which pushes only if every check passed.

## Hard rules

- **Zero cost.** Free tiers only, on services that suspend or refuse rather than bill. Check limits
  on the provider's own pages, never from memory. Never add a payment card anywhere. If the only
  good option costs money, state the price and let the owner decide.
- **Privacy.** Collect the minimum. No analytics, trackers or third-party scripts. Never show the
  Google name or email. No personal data in URLs, logs or error reports. Addresses only as keyed
  hashes. Deleting an account deletes everything.
- **Security.** Every request is hostile. Every rule is enforced in the API *and* the database.
  Parameterised queries only. RLS forced on every table in schema `app`. The API connects as a
  restricted role. Never weaken a check to make something pass.
- **Secrets** never in git, chat, logs or `VITE_` variables. The owner pastes them into files
  themselves (`open -e .local/api.env`). Never type the owner's passwords or sign in for them.
- **Verify, don't assume.** Reproduce a bug before fixing it. For every rule that matters, break it
  on purpose, confirm a test fails, restore it. Check UI in a real browser at 320, 375 and 430 wide
  plus desktop, in light and dark. Report what was *not* verified as plainly as what was.
- **Scope.** Don't add features that weren't asked for: name them and let the owner choose.
  Stop and give click-by-click steps for anything needing the owner's accounts, money, legal
  decisions or physical devices.

## Skill router

`graphinity-build` runs these in order. Load the full skill when a stage needs its depth; per
task, not all at once: unused skills only crowd out the code.

| Work | Skills |
|---|---|
| Starting a feature or step | `spec-driven-development`, `planning-and-task-breakdown` |
| API endpoints, module boundaries | `api-and-interface-design` |
| Points, trust, anti-cheat, routing, sign-in, permissions | `doubt-driven-development` (fresh-eyed challenge before it stands) |
| Writing code | `incremental-implementation`, `test-driven-development` |
| Using any library or service API | `source-driven-development` (official docs, not memory) |
| Screens and components | `frontend-ui-engineering`, `apple-design`, `emil-design-eng` |
| Motion | `animate`; afterwards `improve-animations` |
| Database schema changes | `deprecation-and-migration` (additive, expand then contract) |
| Security-sensitive changes, before each step closes | `security-and-hardening`, `security-review` |
| Before every commit of non-trivial code | `code-review-and-quality` |
| Speed, bundle size | `performance-optimization` |
| Logging, monitoring, error reporting | `observability-and-instrumentation` |
| Something is broken | `systematic-debugging` |
| Before saying anything is done | `verification-before-completion` |
| CI, deploys, launch | `ci-cd-and-automation`, `shipping-and-launch` |
| Commits, branches, pushes | `git-workflow-and-versioning` |
| Recording a decision | `documentation-and-adrs` |

Manual-only skills (the owner must type them; suggest them when useful): `/prototype` (several
versions of a screen to pick from), `/review-animations`, `/pick-ui-library`.
Not for this project: `omni-*`, `cli-*` (OmniRoute tooling), `ckm:slides`, `ckm:banner-design`,
`write-swift`, `animate-expo` (until the native app).
Never install skills or packages from unknown sources without asking: they are instructions or
code we would run.

## Stack

- `apps/web`: React 19 + TypeScript + Vite, static on Cloudflare Pages. No UI framework.
- `apps/api`: Node 24 + Fastify 5 on Render (Singapore). `buildServer(deps)` takes every outside
  dependency as an argument; no test-mode switches in production code.
- `db/schema.sql`: Supabase Postgres (Singapore). One file, safe to run twice, additive only.
- Sign-in: Google ID token (nonce + state, returns to our site), exchanged at Supabase Auth, called
  directly (no supabase-js, no Google script). Scope `openid email` only. Access token in
  memory, refresh token in sessionStorage, never localStorage. The API verifies every token.
- Supabase project `cfwzkjpqpmttqbbnnzch`: Data API off, email sign-in off, Google on.
- GitHub: `Chiranjeevi560/Graphinity` (private), pushed over SSH.

## Commands

Use Node 24 (`source ~/.nvm/nvm.sh && nvm use 24`; the machine default is 20).

| Task | Command |
|---|---|
| Install (scripts disabled by `.npmrc`) | `npm ci` |
| Local database (creates `.local/`) | `npm run db:start` / `db:apply` / `db:stop` |
| Local sign-in stand-in (no Google needed) | `npm run dev:auth` |
| API on :3000 with the stand-in / with the real Supabase | `npm run dev:api:local` / `npm run dev:api` |
| Website on :5173 | `npm run dev:web` |
| Website against the real Supabase | `npm --workspace apps/web run dev -- --mode supabase` (don't run `dev:auth`) |
| All tests (integration tests need the local database) | `npm test` |
| Typecheck / build | `npm run typecheck` / `npm run build` |
| Production build with production headers | `npm --workspace apps/web run preview` (:4173; restart after header changes) |

New dependencies: `npm install --before=<date two weeks ago> ...` (exact versions, nothing
published in the last two weeks).

In the Claude app, `.claude/launch.json` starts every server through `scripts/node24.mjs`: the
launcher uses the machine's Node 20, which can't run the API (it crashed at start, and the site said
every request failed). A hidden browser pane gets no animation frames, so screenshots can catch a
fade half-way: measure state with JavaScript before calling it a bug.

## Conventions

- Comments explain why, not what. Match the surrounding style.
- TypeScript strict, `erasableSyntaxOnly` (no parameter properties, no enums); imports use `.ts`
  extensions.
- API errors are `{ error: code, message: plain words }`. Messages say what happened and what to
  do. Never "Oops!".
- Request schemas refuse unknown properties and wrong types (Fastify coercion is off).
- Logs: route pattern, status and time only. Never URLs, addresses, headers, bodies, error messages
  or hostnames.
- Web: design tokens in `src/styles/tokens.css` only; rem units; 44px tap targets; squircles via
  `SquircleLayers`; springs from `src/lib/spring.ts` (a test keeps the CSS in sync); text on any
  fill checked at 4.5:1 or more.
- Screens are lazy-loaded route chunks (default exports); components are named exports.
- New tables: `ENABLE` + `FORCE ROW LEVEL SECURITY`, explicit grants to `app_api`, policies, and a
  matching integration test. Bump the version in `app.schema_meta`.

## Commits

One concern per commit. The message says what was wrong, the root cause with evidence, what
changed, and what was verified (including what wasn't). Push to `origin main` after committing
when the owner has asked for pushes.

## Docs to keep current in the same commit

`docs/RUNBOOK.md` (how to run and deploy), `docs/SECURITY.md` (threat model, assumptions, known
gaps), `docs/API.md`, `docs/ENVIRONMENT.md`, `docs/PLAN.md` (step status), and
`docs/SETUP-ACCOUNTS.md` (owner's click-by-click steps).
