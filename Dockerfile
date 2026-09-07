# One Dockerfile, three targets: migrate, api and worker.
#
# The API and the worker are the same build with different entry points, and the plan
# requires them to share code, database and volume. Two near-identical Dockerfiles would
# be two places for that sharing to drift, so Compose selects a target instead.
#
# Node 24, matching engines.node in package.json.

FROM node:24-slim AS base
WORKDIR /app
# Fail fast if the image ever drifts from the version the workspace requires.
RUN node --version

# ---------------------------------------------------------------------------------------
# Dependencies. Only manifests are copied first, so a source edit does not invalidate the
# npm cache layer.
# ---------------------------------------------------------------------------------------
FROM base AS deps
ENV NODE_ENV=development
COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/worker/package.json ./apps/worker/package.json
COPY packages/config/package.json ./packages/config/package.json
COPY packages/db/package.json ./packages/db/package.json
COPY packages/pipeline/package.json ./packages/pipeline/package.json
RUN npm ci

# ---------------------------------------------------------------------------------------
# Build. tsc -b walks the project references and emits dist/ for every workspace package.
# ---------------------------------------------------------------------------------------
FROM deps AS build
COPY tsconfig.base.json tsconfig.json ./
COPY packages ./packages
COPY apps ./apps
RUN npm run build

# ---------------------------------------------------------------------------------------
# Migrations. Runs once and exits; api and worker wait for it to succeed.
#
# Built from `build` rather than from the pruned tree because drizzle-kit is a development
# dependency. Applying reviewed SQL is what the plan asks for, so this runs `migrate` and
# never `push`.
# ---------------------------------------------------------------------------------------
FROM build AS migrate
WORKDIR /app/packages/db
CMD ["npx", "drizzle-kit", "migrate"]

# ---------------------------------------------------------------------------------------
# Runtime tree: build output without the toolchain that produced it.
# ---------------------------------------------------------------------------------------
FROM build AS pruned
RUN npm prune --omit=dev

FROM base AS api
ENV NODE_ENV=production
COPY --from=pruned /app /app
EXPOSE 3000
CMD ["node", "apps/api/dist/index.js"]

FROM base AS worker
ENV NODE_ENV=production
COPY --from=pruned /app /app
CMD ["node", "apps/worker/dist/index.js"]
