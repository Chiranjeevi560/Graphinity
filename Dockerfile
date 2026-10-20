# The API's container image. Built once per main commit by the release
# workflow and promoted unchanged: staging runs it, then production runs the
# very same image (docs/adr/0002). Node 24 runs the TypeScript source
# directly, as on Render today, so there is no separate build output to drift.
#
#   docker build --build-arg RELEASE=$(git rev-parse HEAD) -t graphinity-api .
#
# The base is pinned by digest (Docker Hub, checked 2026-10-20): a moved tag
# can't change what ships. Dependabot proposes newer digests.
ARG NODE_IMAGE=node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5

FROM ${NODE_IMAGE} AS deps
WORKDIR /app
# Only what the lockfile says, production dependencies of the API only, and
# no install scripts (.npmrc). The website's package.json is needed for the
# workspace to resolve; none of its dependencies are installed.
COPY package.json package-lock.json .npmrc ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci --omit=dev --workspace @graphinity/api && npm cache clean --force

FROM ${NODE_IMAGE}
# The commit this image was built from, reported by /health. Required: a
# release that can't say what it is can't be checked after a deploy.
ARG RELEASE
RUN test "$(printf %s "$RELEASE" | grep -cE '^[0-9a-f]{40}$')" = 1 || \
  { echo 'Build with --build-arg RELEASE=<full commit hash>' >&2; exit 1; }
ENV NODE_ENV=production RELEASE=${RELEASE}
WORKDIR /app
# Everything belongs to root and is read-only to the user the server runs as:
# a compromised server process can't rewrite its own code.
COPY --from=deps /app /app
COPY apps/api/src apps/api/src
COPY db/migrations db/migrations
USER node
EXPOSE 3000
CMD ["node", "apps/api/src/main.ts"]
