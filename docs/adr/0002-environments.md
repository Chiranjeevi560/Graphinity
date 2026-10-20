# ADR 0002: Development, staging and production, with one build promoted

Date: 2026-10-20. Status: accepted by the owner; built in phases (table below). Extended by the
approved architecture plan, `docs/plans/architecture-migration.md` (previews, migrations, observability,
backups, infrastructure as code, Git workflow), whose phase numbers supersede the table below.

## Context

The owner wants the pipeline world-class teams use: local development on a local database, GitHub
Actions running every check, a staging environment verified by hand (Google sign-in, routing,
moderation), then production, with the **same build** promoted and no manual code changes. Local
development must never reach the production database. Each environment has its own configuration,
secrets, OAuth client and database. Free tiers only (CLAUDE.md), and each limit below was checked
on the provider's own page on 2026-10-20.

## Decisions

1. **The repository is public** (owner's choice). On GitHub Free, private repositories have no
   Environments, so no production-only secrets or approval gate, and Actions stops after 2,000
   minutes a month. Public repositories get both free. Secrets stay in GitHub's secret store and
   the platforms' dashboards, never in the code. Before publishing, the whole history was scanned
   (gitleaks: no leaks in 95 commits; no settings files, emails or phone numbers ever committed;
   commit messages hold no secret-shaped strings). Outside contributors' pull requests need the
   owner's approval to run workflows.
2. **Three environments.** Development: this computer, local Postgres and the sign-in stand-in,
   no Google, no shared secrets. Staging and production: each its own Supabase project (the free
   plan allows exactly two), Render service in its **own workspace** (750 free hours per
   workspace; production awake all month uses 744, and running out suspends every service in the
   workspace), Cloudflare Pages project, and Google OAuth client. The existing Supabase project,
   whose secret key has been on the owner's computer, becomes staging; production is new and is
   never configured on a laptop.
3. **One build, configured at deploy time.**
   - Website: the build compiles in no environment. A tested deploy step (`apps/web/stamp.ts`)
     copies it and writes only `index.html` (a settings meta tag and the site's address),
     `_headers` (CSP), `robots.txt` and `sitemap.xml`. It refuses a build that names any
     environment. Every hashed script and style is the same bytes in staging and production.
   - API: one container image per commit, pushed to GitHub's registry and deployed **by digest**
     to staging, then the same digest to production (Render deploy hooks accept a digest). The
     image carries `RELEASE` (its commit); the environment comes from `APP_ENV` at run time.
     `/health` reports both, so a deploy waits for its own commit.
4. **Database changes through the pipeline**, as numbered forward-only migrations starting from
   today's `db/schema.sql` (version 16): staging migrated automatically before its deploy,
   production after approval, both before the code that needs them. Expand only, so rolling
   back the code is always safe.

## Trade-offs accepted

- Stamping adds a step and a script to maintain, in exchange for a real "same build" guarantee
  instead of "same commit, built twice".
- The image adds a Dockerfile and image storage; Render's own Node builds would be simpler but
  build separately in each environment.
- Free tiers cap scale: one Render instance that sleeps when idle, 500 MB of Postgres. The design
  doesn't: the API is stateless apart from what step 5 below moves out, and each step to paid
  hosting is the owner's decision with prices checked then.

## Phases

Status: ✅ built and tested · ◐ in progress · ○ planned

| Phase | What | Status |
|---|---|---|
| 1 | Environments in code: `APP_ENV` and `RELEASE` (refused when wrong), `/health` reports them; website settings stamped at deploy, neutral build checked on every stamp | ✅ |
| 2 | Migrations: runner, baseline 16, CI from empty and from the last release, guard against one-step drops and renames | ○ |
| 3 | API image: pinned base, non-root, production dependencies only, scanned, build attestation | ○ |
| 4 | Pipeline: checks on every push; on `main` build once, migrate and deploy staging, wait for `/health`, upload the stamped site, smoke tests; promotion of the same artifacts to production behind the owner's approval; rollback by re-promoting | ○ |
| 5 | More than one server: database locks around the minute jobs now; live updates over LISTEN/NOTIFY and shared rate limits when scaling | ○ |
| 6 | Owner's accounts per environment (click-by-click in SETUP-ACCOUNTS.md), first release, keep-awake for production only | ○ |
