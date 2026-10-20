# Deployment

How a change reaches people: built once, checked, then promoted unchanged. Decisions behind it:
ADR 0002 (environments, one promoted build) and `docs/plans/architecture-migration.md`.

## From pull request to release

```
pull request ──► CI (every check, browsers ×3, API image started in production mode)
      │
  merged to main (Rebase and merge)
      │
CI on main passes ──► Release workflow (.github/workflows/release.yml), once per commit:
      • API image   ghcr.io/<owner>/graphinity-api:<commit>  + signed provenance + SBOM
      • website     neutral build (no environment inside), stamped per environment at deploy
      • migrations  db/migrations exactly as that commit has them
      • release.json  commit, image digest, build time
      │
staging ──► checks ──► production      (the same files; nothing rebuilt)
```

Staging and production deploys are Phase 5 of the plan. Until then the API deploys from Render's
own build (`render.yaml`) and the website by Direct Upload, as RUNBOOK.md describes.

## What each release contains

| Piece | Where | Proves |
|---|---|---|
| API image | GitHub Container Registry, tagged with the full commit hash | `/health` reports that commit (`RELEASE`), so a deploy can wait for its own commit to answer |
| Provenance | Attached to the image (`gh attestation verify oci://<image> --repo <owner>/Graphinity`) | It was built by this repository's release workflow from that commit, not on someone's laptop |
| SBOM | `sbom.spdx.json` in the release artifact | Every package inside the image, for audits and for checking a new vulnerability against old releases |
| Website | `website/` in the release artifact | Stamped per environment by `node apps/web/stamp-dist.ts`, which refuses a build with any environment compiled in |
| Migrations | `migrations/` in the release artifact | Applied by `apps/api/src/migrate-main.ts` before the image starts; refused if the database is newer |

Release artifacts are kept 90 days; images until deleted.

## The image

- Base: `node:24-bookworm-slim`, pinned by digest; Dependabot proposes new digests (14-day cooldown).
- Production dependencies of the API only, from the lockfile, install scripts off.
- Code and dependencies owned by root, read-only to the `node` user the server runs as.
- `.dockerignore` admits only what the Dockerfile copies: `.local` (secrets) can never reach a build.
- Refuses to build without `RELEASE=<full commit hash>`.
- Every pull request builds it, scans it (osv-scanner; Debian findings reported, npm findings at
  high already fail `check:deps`), and starts it in production mode against CI's database.

## Rolling back

Deploy the previous release's image and website. The database stays: migrations are additive, so
the previous code works with the newer schema (db/migrations/README.md).

## Owner steps (once, when Phase 5 starts deploying images)

GitHub makes a new container image private, even in a public repository. Render can pull a public
image without a password, so the image should be made public (it holds no secrets: `.dockerignore`
and the build refuse them):
1. On GitHub, open your profile, **Packages**, then **graphinity-api**.
2. **Package settings** (right side), **Change visibility**, **Public**, type the name to confirm.
