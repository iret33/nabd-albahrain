/**
 * Boot-time environment validation. `src/instrumentation.ts` calls
 * `assertProductionEnv()` on the Node runtime at real server start (never
 * during `next build`, so `docker build` and CI builds need no secrets).
 *
 * Only enforced when NODE_ENV === "production": local dev and tests keep the
 * convenient short `.env.local` tokens. The secret rules are mirrored in POSIX
 * sh by `docker/entrypoint.sh` (which runs BEFORE `prisma migrate deploy`);
 * `tests/security/entrypoint.test.ts` keeps the two in lockstep, so change both
 * together.
 *
 * Messages name the offending variable and the rule, never its value.
 */

export type EnvLike = Record<string, string | undefined>;

export const MIN_SECRET_LENGTH = 32;

/** A secret whose lowercase form STARTS with one of these is a copy-paste placeholder. */
const PLACEHOLDER_PREFIXES = [
  "change-me",
  "changeme",
  "change_me",
  "replace-me",
  "replace_me",
  "your-",
  "your_",
  "dev-",
  "dev_",
  "test-",
  "test_",
  "example",
] as const;

/** ...or CONTAINS one of these anywhere. */
const PLACEHOLDER_FRAGMENTS = ["changeme", "change-me", "change_me", "password", "placeholder"] as const;

/** `openssl rand -hex 32` has 16 symbols over 64 chars; fewer than this many distinct chars is not random. */
const MIN_DISTINCT_CHARS = 8;

/** Why a secret is unacceptable, or null when it looks like a real random secret. */
export function weakSecretReason(value: string | undefined): string | null {
  if (!value) return "is not set";
  if (value.length < MIN_SECRET_LENGTH) return `is shorter than ${MIN_SECRET_LENGTH} characters`;
  const lower = value.toLowerCase();
  if (PLACEHOLDER_PREFIXES.some((p) => lower.startsWith(p)) || PLACEHOLDER_FRAGMENTS.some((f) => lower.includes(f))) {
    return "looks like a placeholder value";
  }
  if (new Set(value).size < MIN_DISTINCT_CHARS) return "is not random enough (too few distinct characters)";
  return null;
}

/** Treat "" like unset so `FOO=` in an env file behaves like omitting it. */
function present(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== "";
}

/** A non-negative finite number when set; `Number("abc")`/`Infinity` would otherwise silently become NaN/Infinity downstream. */
function checkNonNegativeNumber(env: EnvLike, name: string, problems: string[]): void {
  const raw = env[name];
  if (!present(raw)) return;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) problems.push(`${name} must be a number >= 0 when set`);
}

/**
 * Every problem with a production environment (empty list = fine). Pure: pass
 * any env-shaped object. Returns [] outside production.
 */
export function validateProductionEnv(env: EnvLike = process.env): string[] {
  if (env.NODE_ENV !== "production") return [];
  const problems: string[] = [];
  const hint = " (generate one with: openssl rand -hex 32)";

  for (const name of ["ADMIN_TOKEN", "SYNC_TOKEN"] as const) {
    const reason = weakSecretReason(env[name]);
    if (reason) problems.push(`${name} ${reason}${hint}`);
  }
  if (present(env.ADMIN_TOKEN) && env.ADMIN_TOKEN === env.SYNC_TOKEN) {
    problems.push("ADMIN_TOKEN and SYNC_TOKEN must be different (leaking one must not grant the other)");
  }
  // Optional override of the session-signing key: held to the same standard.
  if (present(env.SESSION_SECRET)) {
    const reason = weakSecretReason(env.SESSION_SECRET);
    if (reason) problems.push(`SESSION_SECRET ${reason} (unset it to derive session keys from ADMIN_TOKEN)`);
  }

  if (!present(env.DATABASE_URL)) {
    problems.push("DATABASE_URL is not set");
  } else if (!/^postgres(ql)?:\/\//i.test(env.DATABASE_URL.trim())) {
    problems.push("DATABASE_URL must be a postgres:// or postgresql:// URL");
  }

  if (present(env.SYNC_CONCURRENCY)) {
    // Out-of-range values are not harmless: <= 0 deadlocks the request queue.
    const n = Number(env.SYNC_CONCURRENCY);
    if (!Number.isInteger(n) || n < 1 || n > 10) problems.push("SYNC_CONCURRENCY must be an integer between 1 and 10 when set");
  }

  for (const name of [
    "AUTO_SYNC_INTERVAL_MINUTES",
    "CACHE_TTL_SECONDS",
    "PUBLIC_REFRESH_ENABLED",
    "PUBLIC_REFRESH_CATALOG_COOLDOWN_SECONDS",
    "PUBLIC_REFRESH_DATASET_COOLDOWN_SECONDS",
    "PUBLIC_REFRESH_MAX_RECORDS",
  ]) {
    checkNonNegativeNumber(env, name, problems);
  }

  return problems;
}

/**
 * Throws one Error listing every problem, so a misconfigured deploy fails at
 * start with a complete to-do list instead of one fix per restart. No-op
 * outside production.
 */
export function assertProductionEnv(env: EnvLike = process.env): void {
  const problems = validateProductionEnv(env);
  if (problems.length === 0) return;
  throw new Error(
    `Invalid production environment (${problems.length} problem${problems.length === 1 ? "" : "s"}):\n` +
      problems.map((p) => `  - ${p}`).join("\n") +
      "\nFix them in .env (see .env.example) and restart.",
  );
}
