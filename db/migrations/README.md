# Database migrations

Every change to the database is a numbered SQL file here, applied in order, each exactly once.
`apps/api/src/migrations.ts` runs them and keeps a record in `app.schema_migrations`.

## Adding a change

1. Make a new file with the next number: `0002_what_it_does.sql` (lowercase, underscores).
2. Write plain SQL. Leave out `BEGIN` and `COMMIT`: the runner gives each file its own transaction,
   so a file applies completely or not at all, together with its record.
3. If the API depends on the change, raise the schema version at the end of the file:
   Increment the current schema version by one. The latest migration sets version 40.
4. New tables: `ENABLE` and `FORCE ROW LEVEL SECURITY`, explicit grants to `app_api`, policies, and
   an integration test (the RLS test fails if a table lacks them).
5. `npm run db:apply` applies it locally. `npm test` runs every test against freshly migrated
   databases.

**Never edit or delete a file once it has shipped.** Databases that already ran it would never
see the edit, so environments would quietly differ. The runner refuses to continue if a file's
checksum no longer matches its record, and CI refuses any edit to a file that is on `main`. Fix a
mistake with a new file.

## Changes that remove or rename (expand, then contract)

During a deploy the old server keeps running against the new database for a while. So a change
that removes or renames something the old code uses breaks it. Do it in two releases:

1. **Expand:** add the new column or table, copy the data across, switch the code to it.
2. **Contract**, in a later release, once no running code uses the old one: remove it.

The lint (`node scripts/check-migrations.mjs`, part of `npm run check:fast`) refuses `DROP TABLE`,
`DROP COLUMN`, `TRUNCATE`, `RENAME` and column type changes unless the file says why it is safe now,
on its own line:

```sql
-- contract: nothing reads answers.legacy_score since 0007, released 2026-11-02
ALTER TABLE app.answers DROP COLUMN legacy_score;
```

Replacing a policy, function or trigger (`DROP POLICY IF EXISTS` then `CREATE POLICY`) loses no
data, and is allowed.

## What the runner guarantees

| Guarantee | How |
|---|---|
| Each file once, in order | Record of version and checksum; gaps and repeats in names refused |
| All or nothing | Each file and its record in one transaction |
| Never stalls the site | `lock_timeout` 5 s: a migration waiting for a lock fails instead of queueing every request behind it. Run it again when traffic is quieter |
| Two deploys can't both migrate | One advisory lock for the whole run |
| Code never runs against a newer database by mistake | Refuses a database with migrations this code doesn't have |
| Can see its own record | Refuses a role that doesn't bypass row-level security (the record is forced-RLS with no policy). Supabase's `postgres` is `rolsuper = false, rolbypassrls = true`, checked on the project |

## What CI checks

`scripts/check-migrations.mjs --base <the pull request's base>`:

1. Every file passes the lint.
2. No file that shipped in the base was edited or removed.
3. **An upgrade ends exactly where a fresh install does:** one database gets the base's schema then
   these migrations, another gets these migrations only, and their full `pg_dump --schema-only`
   (tables, constraints, indexes, policies, grants, functions) must be identical. A change that
   only reaches new databases (an extra column inside `CREATE TABLE IF NOT EXISTS`, say) fails
   here; that was tried on purpose.

## The baseline

`0001_baseline.sql` is the schema as it stood at version 16, when it was one hand-applied file
(`db/schema.sql`). It is still safe to run twice, because databases made before migrations (the
local ones, and the Supabase project) adopt it by running it once more: nothing in them changes,
and the record starts. It is never edited again.

## Rolling back

Code rolls back by deploying the previous release. The database doesn't roll back: migrations are
additive, so the previous code still works with the newer schema. A bad migration is fixed by a
new one. (Undoing changes on live data is where data gets lost, which is why most large SaaS teams
work forward only.)
