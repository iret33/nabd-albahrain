/**
 * ONE place that reads and validates every environment variable the sync
 * engine, the scheduler and the public refresh endpoints depend on.
 *
 * Why this exists: the same variable used to be parsed ad hoc in several
 * files (`Number(process.env.SYNC_CONCURRENCY) || 3` accepts `-1`, which
 * makes the rate limiter queue forever and `mapWithConcurrency` spawn zero
 * workers). Everything here is clamped to a safe range, falls back to the
 * documented default on garbage, and warns (once per variable) so a typo in
 * `.env` is visible in the logs instead of silently changing behaviour.
 *
 * The loaders take an `env` argument so they are unit-testable without
 * touching `process.env`.
 */

import { SWITCH_ACCEPTED_TEXT, parseSwitch } from "@/lib/env";

type Env = Record<string, string | undefined>;

const warned = new Set<string>();

function warnOnce(name: string, message: string): void {
  if (warned.has(name)) return;
  warned.add(name);
  console.warn(`[config] ${message}`);
}

/**
 * Parse an integer env var. Unset/empty -> `def`. Non-numeric (including
 * "1.5", "1e3", "abc") -> `def` with a warning. Out of range -> clamped to
 * [min, max] with a warning.
 */
export function parseIntEnv(
  env: Env,
  name: string,
  opts: { def: number; min: number; max: number },
): number {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === "") return opts.def;
  if (!/^-?\d{1,9}$/.test(raw)) {
    warnOnce(name, `${name}=${JSON.stringify(raw)} is not an integer; using the default ${opts.def}.`);
    return opts.def;
  }
  const n = Number.parseInt(raw, 10);
  if (n < opts.min || n > opts.max) {
    const clamped = Math.min(opts.max, Math.max(opts.min, n));
    warnOnce(name, `${name}=${n} is outside ${opts.min}..${opts.max}; clamped to ${clamped}.`);
    return clamped;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Sync engine / HTTP client
// ---------------------------------------------------------------------------

export const DEFAULT_USER_AGENT =
  "nabd-albahrain/1.0 (independent open-data dashboard; contact via hekkapp.com)";

export interface SyncConfig {
  /** Max in-flight portal requests AND max datasets synced in parallel. 1..10. */
  concurrency: number;
  /** Minimum gap between two request starts, in ms. */
  delayMs: number;
  /** Per-attempt deadline for catalog requests (headers AND body), in ms. */
  requestTimeoutMs: number;
  /** Per-attempt deadline for dataset exports (headers AND body), in ms. */
  exportTimeoutMs: number;
  /** Base of the exponential backoff between retries, in ms. */
  retryBaseMs: number;
  /** Retries after the first attempt (HTTP 429/5xx or network errors). */
  maxRetries: number;
  /** Upper bound for a honoured `Retry-After`, in ms. */
  maxRetryAfterMs: number;
  userAgent: string;
}

export function loadSyncConfig(env: Env = process.env): SyncConfig {
  return {
    concurrency: parseIntEnv(env, "SYNC_CONCURRENCY", { def: 3, min: 1, max: 10 }),
    delayMs: parseIntEnv(env, "SYNC_DELAY_MS", { def: 250, min: 0, max: 10_000 }),
    requestTimeoutMs: parseIntEnv(env, "SYNC_REQUEST_TIMEOUT_MS", { def: 30_000, min: 100, max: 600_000 }),
    exportTimeoutMs: parseIntEnv(env, "SYNC_EXPORT_TIMEOUT_MS", { def: 120_000, min: 100, max: 1_800_000 }),
    retryBaseMs: parseIntEnv(env, "SYNC_RETRY_BASE_MS", { def: 1_000, min: 0, max: 60_000 }),
    maxRetries: 2,
    maxRetryAfterMs: 60_000,
    userAgent: env.USER_AGENT?.trim() || DEFAULT_USER_AGENT,
  };
}

/** Evaluated once at import: the HTTP limiter is a process-wide singleton. */
export const syncConfig: SyncConfig = loadSyncConfig();

/**
 * Base URL of the OpenDataSoft API. Read per call (not at import) so tests can
 * point the client at an in-process mock started on a random port.
 */
export function getOdsBaseUrl(env: Env = process.env): string {
  const raw = env.ODS_BASE_URL?.trim();
  return (raw || "https://data.gov.bh/api/explore/v2.1").replace(/\/+$/, "");
}

// ---------------------------------------------------------------------------
// Scheduler / freshness
// ---------------------------------------------------------------------------

/** AUTO_SYNC_INTERVAL_MINUTES: 0 / unset / invalid = scheduler off. Max one week. */
export function getAutoSyncIntervalMinutes(env: Env = process.env): number {
  return parseIntEnv(env, "AUTO_SYNC_INTERVAL_MINUTES", { def: 0, min: 0, max: 10_080 });
}

/** Seconds between boot and the scheduler's first tick (jitter is added on top). */
export function getAutoSyncFirstDelaySeconds(env: Env = process.env): number {
  return parseIntEnv(env, "AUTO_SYNC_FIRST_DELAY_SECONDS", { def: 60, min: 0, max: 3_600 });
}

/**
 * Data is "stale" when the last successful run is older than this: twice the
 * scheduler interval when the scheduler is on, else 48h (an external cron is
 * assumed to run at least daily).
 */
export function getStaleAfterMs(env: Env = process.env): number {
  const interval = getAutoSyncIntervalMinutes(env);
  return interval > 0 ? 2 * interval * 60_000 : 48 * 3_600_000;
}

// ---------------------------------------------------------------------------
// Public refresh (POST /api/refresh)
// ---------------------------------------------------------------------------

export interface PublicRefreshConfig {
  /**
   * PUBLIC_REFRESH_ENABLED is the kill switch: 0/false/no/off turns the public
   * refresh off, 1/true/yes/on (or unset/blank) leaves it on, and anything
   * else FAILS CLOSED (off, with a warning) because an operator reaching for
   * the switch under abuse must not end up with the endpoint still open. In
   * production the boot validator rejects an unrecognised value outright.
   */
  enabled: boolean;
  catalogCooldownSeconds: number;
  datasetCooldownSeconds: number;
  /** Datasets with more catalog rows than this are never downloaded by a public refresh. */
  maxRecords: number;
  /** Datasets re-downloaded by one public refresh at most. */
  maxDatasets: number;
}

/** The kill switch: see PublicRefreshConfig.enabled. */
function publicRefreshEnabled(env: Env): boolean {
  const value = parseSwitch(env.PUBLIC_REFRESH_ENABLED);
  if (value === "invalid") {
    warnOnce(
      "PUBLIC_REFRESH_ENABLED",
      `PUBLIC_REFRESH_ENABLED=${JSON.stringify(env.PUBLIC_REFRESH_ENABLED?.trim())} is not recognised ` +
        `(use ${SWITCH_ACCEPTED_TEXT}); treating it as OFF.`,
    );
    return false;
  }
  return value !== "off";
}

export function loadPublicRefreshConfig(env: Env = process.env): PublicRefreshConfig {
  return {
    enabled: publicRefreshEnabled(env),
    catalogCooldownSeconds: parseIntEnv(env, "PUBLIC_REFRESH_CATALOG_COOLDOWN_SECONDS", {
      def: 120,
      min: 0,
      max: 86_400,
    }),
    datasetCooldownSeconds: parseIntEnv(env, "PUBLIC_REFRESH_DATASET_COOLDOWN_SECONDS", {
      def: 600,
      min: 0,
      max: 86_400,
    }),
    maxRecords: parseIntEnv(env, "PUBLIC_REFRESH_MAX_RECORDS", { def: 100_000, min: 1, max: 10_000_000 }),
    maxDatasets: 5,
  };
}
