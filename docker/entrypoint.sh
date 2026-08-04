#!/bin/sh
# Container entrypoint for the "app" service (Phase 8).
#
# Runs `prisma migrate deploy` against DATABASE_URL before starting the
# Next.js standalone server, so a fresh deploy (or a deploy that adds new
# migrations) never serves traffic against a schema it hasn't applied yet.
# `migrate deploy` (unlike `migrate dev`) is non-interactive, applies only
# already-committed migrations from prisma/migrations/, and is safe to run
# on every container start — a no-op when nothing new is pending.
set -e

echo "[entrypoint] Running prisma migrate deploy..."
node_modules/.bin/prisma migrate deploy

echo "[entrypoint] Starting server..."
exec node server.js
