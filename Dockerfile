# One Dockerfile, four targets: migrate, api, worker and web.
#
# The API and the worker are the same build with different entry points, and the plan
# requires them to share code, database and volume. Two near-identical Dockerfiles would
# be two places for that sharing to drift, so Compose selects a target instead.
#
# web is the exception: it is built by Vite and served by nginx, so it shares the
# dependency stage and nothing after it.
#
# Node 24, matching engines.node in package.json.

FROM docker.io/library/node:24-slim AS base
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
COPY apps/web/package.json ./apps/web/package.json
COPY apps/worker/package.json ./apps/worker/package.json
COPY packages/config/package.json ./packages/config/package.json
COPY packages/contracts/package.json ./packages/contracts/package.json
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
# tsc -b rather than `npm run build`: the root script also builds the web app, which the
# api and worker images have no use for and would carry into their runtime tree.
RUN npx tsc -b

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

# ---------------------------------------------------------------------------------------
# The review interface.
#
# Built from `deps` rather than from `build`: Vite resolves @superjoin/contracts to its
# source through an alias, so the interface does not need the backend packages compiled
# and does not wait on them.
# ---------------------------------------------------------------------------------------
FROM deps AS web-build
# tsconfig.base.json comes along because packages/contracts/tsconfig.json extends it, and
# Vite's transform resolves that chain while compiling the aliased contract source.
COPY tsconfig.base.json ./
COPY packages/contracts ./packages/contracts
COPY apps/web ./apps/web
RUN npm run build --workspace @superjoin/web

# Static files behind nginx, which also proxies the API so the browser sees one origin.
FROM docker.io/library/nginx:1.29-alpine AS web
COPY --from=web-build /app/apps/web/dist /usr/share/nginx/html
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
