# Multi-stage production image for نبض البحرين (Nabd Al-Bahrain).
#
# node:22-alpine throughout, pnpm as the package manager, Next.js's
# `output: "standalone"` server. See docker-compose.yml for how this image
# is run (an "app" service alongside a "db" Postgres service).
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

FROM node:22-alpine AS base
# openssl: required by Prisma's query engine on Alpine/musl.
# libc6-compat: some native deps (sharp-style prebuilt binaries) expect it.
RUN apk add --no-cache openssl libc6-compat
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app

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
RUN pnpm exec prisma generate
RUN pnpm build

# ---------------------------------------------------------------------------
# runner: minimal runtime image.
# ---------------------------------------------------------------------------
FROM base AS runner
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app

RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
# Overlay the complete, alpine-built node_modules — see the note at the top
# of this file for why this is necessary alongside (not instead of) the
# standalone output above.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/prisma ./prisma
COPY docker/entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh && chown -R nextjs:nodejs /app

USER nextjs

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

ENTRYPOINT ["./entrypoint.sh"]
