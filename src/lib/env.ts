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

/**
 * On/off environment switches (PUBLIC_REFRESH_ENABLED): the spellings an
 * operator under pressure actually types. One parser for the boot validator
 * and the runtime loader, so the two cannot drift (the validator used to run a
 * NUMBER check on it, which crash-looped the container on `false` while the
 * loader silently ignored everything but `0`).
 */
export const SWITCH_ON_VALUES = ["1", "true", "yes", "on"] as const;
export const SWITCH_OFF_VALUES = ["0", "false", "no", "off"] as const;
export const SWITCH_ACCEPTED_TEXT = `${SWITCH_OFF_VALUES.join("/")} (off) or ${SWITCH_ON_VALUES.join("/")} (on)`;

export type SwitchValue = "on" | "off" | "unset" | "invalid";

/** Blank/unset is "unset" (the caller's default); anything outside the two lists is "invalid" (callers fail closed). */
export function parseSwitch(raw: string | undefined): SwitchValue {
  if (!present(raw)) return "unset";
  const v = raw.trim().toLowerCase();
  if ((SWITCH_ON_VALUES as readonly string[]).includes(v)) return "on";
  if ((SWITCH_OFF_VALUES as readonly string[]).includes(v)) return "off";
  return "invalid";
}

/**
 * Forwarding headers are believed only when TRUST_PROXY is exactly `1`
 * (surrounding whitespace ignored, like every other variable here). Nothing
 * else counts: `true`/`yes` are rejected at boot instead of being coerced,
 * because silently trusting spoofable headers for a loosely typed value would
 * be the worse failure.
 */
export function trustProxyEnabled(env: EnvLike = process.env): boolean {
  return env.TRUST_PROXY?.trim() === "1";
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
    "PUBLIC_REFRESH_CATALOG_COOLDOWN_SECONDS",
    "PUBLIC_REFRESH_DATASET_COOLDOWN_SECONDS",
    "PUBLIC_REFRESH_MAX_RECORDS",
  ]) {
    checkNonNegativeNumber(env, name, problems);
  }

  if (parseSwitch(env.PUBLIC_REFRESH_ENABLED) === "invalid") {
    problems.push(`PUBLIC_REFRESH_ENABLED must be ${SWITCH_ACCEPTED_TEXT} when set`);
  }

  // Anything but 0/1 would be read as 0 (every visitor in ONE rate-limit
  // bucket, so a few requests lock the refresh button and the admin login for
  // everybody). Rejected rather than coerced: see trustProxyEnabled().
  if (present(env.TRUST_PROXY) && !["0", "1"].includes(env.TRUST_PROXY.trim())) {
    problems.push("TRUST_PROXY must be 0 or 1 when set (1 behind the Cloudflare Tunnel, 0 when the app is exposed directly)");
  }

  return problems;
}

/**
 * Non-fatal findings about a production environment, printed loudly at boot.
 * Not part of `validateProductionEnv`: a hard failure would break `docker
 * compose up` without a proxy and the one-off `docker compose run app sync`
 * containers, which share the entrypoint's environment check. Returns [] outside production.
 */
export function productionEnvWarnings(env: EnvLike = process.env): string[] {
  if (env.NODE_ENV !== "production") return [];
  const warnings: string[] = [];
  if (!present(env.TRUST_PROXY)) {
    warnings.push(
      "TRUST_PROXY is not set, so it is read as 0: every visitor shares ONE rate-limit bucket and a handful of requests " +
        "can lock out the public refresh button and the admin login for everyone. Set TRUST_PROXY=1 behind the " +
        "Cloudflare Tunnel (the supported setup), or TRUST_PROXY=0 explicitly when the app is exposed directly.",
    );
  }
  return warnings;
}

/**
 * Warn when the database pool is too small for the sync engine plus the web
 * app: each dataset being synced pins one connection for its whole
 * transaction, and a page or /api/freshness probe needs a few more. Prisma's
 * default pool is 2 x CPUs + 1 (3 on a 1-vCPU VPS). `cpus` is passed in so
 * this stays import-free and testable. Returns null when the pool is fine.
 */
export function poolSizingWarning(env: EnvLike = process.env, cpus = 1): string | null {
  const concurrencyRaw = Number(env.SYNC_CONCURRENCY);
  const concurrency = Number.isInteger(concurrencyRaw) && concurrencyRaw >= 1 && concurrencyRaw <= 10 ? concurrencyRaw : 3;

  let explicit: number | null = null;
  if (present(env.DATABASE_URL)) {
    try {
      const raw = new URL(env.DATABASE_URL.trim()).searchParams.get("connection_limit");
      const n = raw === null ? NaN : Number(raw);
      if (Number.isInteger(n) && n > 0) explicit = n;
    } catch {
      // An unparseable URL is reported by validateProductionEnv's scheme check; nothing to add here.
    }
  }
  const pool = explicit ?? Math.max(1, Math.floor(cpus)) * 2 + 1;
  const needed = concurrency + 6;
  if (pool >= needed) return null;
  return (
    `The database pool is ${pool} connection(s) (${explicit ? "connection_limit in DATABASE_URL" : "Prisma's default of 2 x CPUs + 1"}) ` +
    `but SYNC_CONCURRENCY=${concurrency} needs about ${needed} (one per dataset being written, plus the web app): ` +
    `a big sync can then starve page loads. Add ?connection_limit=${needed} to DATABASE_URL or lower SYNC_CONCURRENCY.`
  );
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
