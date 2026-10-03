# Multi-stage production image for نبض البحرين (Nabd Al-Bahrain).
#
# node:22-alpine throughout, pnpm as the package manager, Next.js's
# `output: "standalone"` server. See docker-compose.yml for how this image
# is run (an "app" service alongside a "db" Postgres service).
#
# What the image contains (see docker/entrypoint.sh for how it is started):
#   - the Next.js standalone server (`server.js`)
#   - the bundled sync CLI (`dist/sync-cli.cjs`, built by `pnpm build:cli`), so
#     `docker compose run --rm app sync -- --dataset <id>` works in production
#   - the `prisma` CLI + migrations, applied by the entrypoint before start
#
# Prisma + pnpm + Next standalone note: Next's file-tracer does not
# reliably pick up Prisma's native query-engine binary (it's resolved
# dynamically at runtime, not via a static `require()` it can see), and
# pnpm stores the actual generated client deep inside its content-addressed
# `node_modules/.pnpm/...` virtual store rather than flat under
# `node_modules/@prisma`. Rather than hand-picking exactly which files
# Next's tracer did or didn't catch, the `runner` stage below overlays the
# builder's *complete*, correctly-built-for-this-alpine-image `node_modules`
# on top of the standalone output. That guarantees `@prisma/client`, its
# query engine, and the `prisma` CLI (needed by `docker/entrypoint.sh` to
# run `migrate deploy` before the server starts) are all present and built
# for the right platform, at the cost of a larger image than a purely
# traced one — a deliberate, standard trade-off for Prisma in Docker.
#
# That overlay includes devDependencies, and they cannot simply be pruned
# (`pnpm prune --prod`): `prisma` itself is a devDependency, and the CLI plus
# esbuild (for the bundle) are needed at build/start time. It is mitigated
# instead by making the whole application tree read-only for the runtime user
# (only `.next/cache` is writable), so code execution inside the server cannot
# rewrite the application or its dependencies.
#
# Known, accepted exposure: the overlay also carries sharp + libvips (Next's
# optional image-optimizer dependency; `pnpm audit --prod` lists high advisories
# for them) and deepmerge-ts (under prisma's config loader). Neither is
# reachable: next.config.ts sets images.unoptimized, so /_next/image answers 404
# before sharp is ever required, and there is no prisma.config.ts for
# deepmerge-ts to merge. The CI audit step keeps critical advisories blocking
# and prints the highs as a warning (see .github/workflows/ci.yml). Dropping
# sharp from the install is a lockfile change, tracked outside this file.

FROM node:22-alpine AS base
# openssl: required by Prisma's query engine on Alpine/musl.
# libc6-compat: glibc shim for prebuilt native binaries that some dependencies
# ship (Next's optional ones included).
RUN apk add --no-cache openssl libc6-compat
WORKDIR /app
# Pin pnpm to the exact version in package.json's "packageManager" field (the
# same one CI and local development use) instead of floating on `latest`:
# `corepack prepare --activate` with no argument reads that field.
COPY package.json ./
RUN corepack enable && corepack prepare --activate

# ---------------------------------------------------------------------------
# deps: install dependencies (this is what `prisma generate`'s own
# postinstall hook runs against, so the schema must already be present).
# ---------------------------------------------------------------------------
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY prisma ./prisma
RUN pnpm install --frozen-lockfile

# ---------------------------------------------------------------------------
# builder: full source + build. Re-runs `prisma generate` explicitly
# (idempotent, cheap) so the generated client is guaranteed fresh even if
# the schema changed after `deps`'s install-time generate.
# ---------------------------------------------------------------------------
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# NEXT_PUBLIC_* values are inlined by `next build`, so the public site URL
# (canonical links, sitemap, robots) must be known HERE, not just at runtime.
# docker-compose.yml passes it from .env; the default is the documented domain.
ARG NEXT_PUBLIC_SITE_URL=https://data.hekkapp.com
ENV NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL
# The app has no static assets today and git cannot track an empty directory,
# so a fresh clone has no public/ — which would make the runner's COPY fail.
RUN mkdir -p public
RUN pnpm exec prisma generate
RUN pnpm build
# Bundle the sync CLI (src/lib/sync/cli.ts -> dist/sync-cli.cjs).
RUN pnpm build:cli

# ---------------------------------------------------------------------------
# runner: minimal runtime image.
# ---------------------------------------------------------------------------
FROM base AS runner
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app

RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs

# Everything below is copied as root and stays root-owned: the runtime user
# can read and execute it but not modify it.
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
# Overlay the complete, alpine-built node_modules — see the note at the top
# of this file for why this is necessary alongside (not instead of) the
# standalone output above.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/dist ./dist
COPY docker/entrypoint.sh ./entrypoint.sh
# The one place the server writes at runtime is Next's data/fetch cache.
RUN chmod 0555 ./entrypoint.sh \
    && mkdir -p .next/cache \
    && chown -R nextjs:nodejs .next/cache

USER nextjs

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
# Let the app own SIGTERM/SIGINT (src/lib/sync/runtime.ts): a container stop in
# the middle of a sync then aborts the run, marks its SyncLog row "aborted" and
# releases the sync lock immediately, instead of leaving "running" state behind
# for the 10-minute stale window. Without a running sync it exits at once.
ENV NEXT_MANUAL_SIG_HANDLE=true

# Which build is this? /api/health/ready reports it as `version`. Declared this
# late on purpose: a per-commit value earlier would invalidate every layer after
# it (node_modules overlay included) on every commit, and the builder/deps
# stages never read it. `.git` is not in the build context, so the value has to
# come from outside: `GIT_SHA=$(git rev-parse --short HEAD) docker compose up
# -d --build` (compose passes it as a build arg) or CI's `github.sha`. Unset
# stays empty and the endpoint reports `version: null`.
ARG GIT_SHA=
ENV GIT_SHA=$GIT_SHA
LABEL org.opencontainers.image.revision="$GIT_SHA"

# Liveness only (/api/health deliberately does not touch Postgres). Gives plain
# `docker run` the same signal docker-compose.yml's healthcheck gives compose.
# --start-period covers the entrypoint's `prisma migrate deploy`.
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
    CMD wget --quiet --tries=1 --spider "http://127.0.0.1:${PORT:-3000}/api/health" || exit 1

ENTRYPOINT ["./entrypoint.sh"]
