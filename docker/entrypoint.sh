#!/bin/sh
# Container entrypoint for the "app" image (POSIX sh, busybox-safe).
#
#   (no arguments)           check secrets -> prisma migrate deploy -> start the
#                            Next.js standalone server
#   sync [--] [flags...]     check secrets -> prisma migrate deploy -> run the
#                            bundled sync CLI once and exit, e.g.
#                              docker compose run --rm app sync -- --dataset <id> --force
#                            (flags: --dataset --force --limit --recompute --dry-run)
#   anything else            exec exactly that (`sh`, `node -v`, ...): no checks,
#                            no migration, so a broken .env can still be debugged
#
# `migrate deploy` (unlike `migrate dev`) is non-interactive, applies only
# already-committed migrations from prisma/migrations/, and is safe to run on
# every container start — a no-op when nothing new is pending (Prisma takes a
# database advisory lock, so a one-shot `sync` racing the server is harmless).
set -eu

fail() {
  echo "[entrypoint] FATAL: $*" >&2
  exit 1
}

# Fail closed on weak secrets BEFORE touching the database. This mirrors
# validateProductionEnv() in src/lib/env.ts rule for rule (same placeholder
# list, same 32-char minimum, same "8 distinct characters" floor);
# tests/security/entrypoint.test.ts runs both over one matrix, so change them
# together. Messages name the variable, never its value.
check_secret() {
  name=$1
  eval "value=\${$name-}"
  [ -n "$value" ] || fail "$name is not set (generate one with: openssl rand -hex 32)"
  [ "${#value}" -ge 32 ] || fail "$name is shorter than 32 characters (generate one with: openssl rand -hex 32)"
  lower=$(printf '%s' "$value" | tr 'A-Z' 'a-z')
  case "$lower" in
    change-me* | changeme* | change_me* | replace-me* | replace_me* | your-* | your_* | dev-* | dev_* | test-* | test_* | example*)
      fail "$name looks like a placeholder value (generate one with: openssl rand -hex 32)"
      ;;
    *changeme* | *change-me* | *change_me* | *password* | *placeholder*)
      fail "$name looks like a placeholder value (generate one with: openssl rand -hex 32)"
      ;;
  esac
  distinct=$(printf '%s' "$value" | fold -w1 | sort -u | wc -l | tr -d ' ')
  [ "$distinct" -ge 8 ] || fail "$name is not random enough (too few distinct characters)"
}

check_environment() {
  [ "${NODE_ENV:-}" = "production" ] || return 0
  check_secret ADMIN_TOKEN
  check_secret SYNC_TOKEN
  [ "$ADMIN_TOKEN" != "$SYNC_TOKEN" ] || fail "ADMIN_TOKEN and SYNC_TOKEN must be different"
  [ -n "${DATABASE_URL:-}" ] || fail "DATABASE_URL is not set"
}

mode=server
case "${1:-}" in
  "") ;;
  sync)
    mode=sync
    shift
    if [ "${1:-}" = "--" ]; then shift; fi
    ;;
  *) exec "$@" ;;
esac

check_environment

echo "[entrypoint] Running prisma migrate deploy..."
node_modules/.bin/prisma migrate deploy

if [ "$mode" = "sync" ]; then
  echo "[entrypoint] Running sync CLI..."
  exec node dist/sync-cli.cjs "$@"
fi

echo "[entrypoint] Starting server..."
exec node server.js
