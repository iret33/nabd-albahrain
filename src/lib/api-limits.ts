/**
 * Abuse limits of the public API (`/api/v1/*`), the one anonymous surface whose
 * requests are expensive: a CSV export streams up to 300,000 rows (0.6 CPU-seconds
 * per 50,000), and twenty of them in parallel pushed every other page of the
 * site from 25 ms to seconds. Three layers, cheapest first:
 *
 *  1. A per-client request budget on EVERY route (`guardApi`), checked before
 *     anything is parsed or read. CSV starts have their own, much smaller budget.
 *  2. A per-client cap on concurrent CSV streams (`acquireCsvSlot`), so one client
 *     cannot run twenty at once.
 *  3. A global cap on concurrent CSV streams, so many clients together cannot
 *     either. A slot is held until the stream ends, fails or is cancelled
 *     (`createCsvStream` calls the release), because `run(() => new Response(...))`
 *     would free it as soon as the Response object is returned.
 *
 * The in-process counters (`@/lib/rate-limit`, `@/lib/slot-limiter`) are per
 * server, which matches the single-container deployment; a Cloudflare rate rule on
 * `/api/v1/` in front is still the right place for anything stronger.
 *
 * Every refusal is JSON with `Retry-After`, `no-store` and CORS headers (see
 * `tooManyRequests` / `serverBusy`): a browser client must be able to read it, and
 * a CDN must never cache it.
 *
 * Client identity is `clientKey()` (`@/lib/rate-limit`): the forwarded address
 * when TRUST_PROXY=1, else the single key "local". When it cannot tell clients
 * apart, per-client limits would put the whole world in one bucket, so that bucket's
 * budgets are multiplied (`UNKNOWN_CLIENT_FACTOR`) and the misconfiguration is
 * logged once; only the global caps still protect the server.
 */

import { clientKey, peekRateLimit, rateLimit } from "@/lib/rate-limit";
import { createSlotLimiter, type SlotLimiter } from "@/lib/slot-limiter";
import { serverBusy, tooManyRequests } from "@/lib/api-v1";

/** Requests per client per minute, any route. Generous: a keyset reader pages 300k rows in ~300 requests. */
export const API_READ_BUDGET = { limit: 120, windowMs: 60_000 } as const;
/** CSV exports a client may START per ten minutes. Behind CGNAT many people share an address, so not tiny. */
export const API_CSV_BUDGET = { limit: 30, windowMs: 600_000 } as const;
/**
 * Concurrent CSV streams per client / per server. Deliberately small: a stream is CPU-bound on the one
 * Node thread that also renders every page. Measured on a 300,000-row dataset (4-core box, /about as
 * the probe): idle 17 ms; one stream p50 30 / p95 60 ms; two p50 86 / p95 340 ms; four p50 461 / p95
 * 689 ms; twenty uncapped p50 2,076 ms. Two keeps the rest of the site fast, and a client holds at
 * most one of them so it can never take both.
 */
export const CSV_MAX_PER_CLIENT = 1;
export const CSV_MAX_CONCURRENT = 2;
/** When clients cannot be told apart, every budget is this many times larger (the one shared bucket stands for everyone). */
export const UNKNOWN_CLIENT_FACTOR = 10;

const SHARED_KEY = "local";

const g = globalThis as unknown as { __nabdCsvStreams?: SlotLimiter; __nabdApiKeyWarned?: boolean };
/** On `globalThis` like the other limiters: Next may evaluate this module once per route bundle. */
function csvStreams(): SlotLimiter {
  return (g.__nabdCsvStreams ??= createSlotLimiter(CSV_MAX_CONCURRENT, { perKey: CSV_MAX_PER_CLIENT }));
}

function identify(req: Request): { key: string; shared: boolean } {
  const key = clientKey(req.headers);
  const shared = key === SHARED_KEY;
  if (shared && !g.__nabdApiKeyWarned && process.env.NODE_ENV === "production") {
    g.__nabdApiKeyWarned = true;
    console.warn(
      "[api/v1] clientKey() cannot tell API clients apart (set TRUST_PROXY=1 behind Cloudflare / the reverse proxy): " +
        `all callers share one rate-limit bucket, so its budgets are x${UNKNOWN_CLIENT_FACTOR}.`,
    );
  }
  return { key, shared };
}

const scaled = (budget: { limit: number; windowMs: number }, shared: boolean) => ({
  limit: shared ? budget.limit * UNKNOWN_CLIENT_FACTOR : budget.limit,
  windowMs: budget.windowMs,
});

/** True for `?format=csv` (cheap read of one parameter, done BEFORE the full validation). */
export function wantsCsv(searchParams: URLSearchParams): boolean {
  return (searchParams.get("format") ?? "").trim().toLowerCase() === "csv";
}

/**
 * First thing every `/api/v1` GET does. Counts the request against the client's read budget and, for a
 * CSV, refuses early when the (separate) CSV budget is already used up. CSV starts are COUNTED later,
 * by `acquireCsvSlot`, once the request is known to be valid, so a mistyped request does not burn them.
 * Returns the 429 to send, or null to carry on.
 */
export function guardApi(req: Request, kind: "read" | "csv" = "read", now = Date.now()): Response | null {
  const { key, shared } = identify(req);
  const read = rateLimit(`api:${key}`, scaled(API_READ_BUDGET, shared), now);
  if (!read.ok) return tooManyRequests(read.retryAfterSeconds);
  if (kind === "csv") {
    const csv = peekRateLimit(`apicsv:${key}`, scaled(API_CSV_BUDGET, shared), now);
    if (!csv.ok) {
      return tooManyRequests(csv.retryAfterSeconds, "Too many CSV exports. Please wait before exporting again, or page through the JSON records.");
    }
  }
  return null;
}

/**
 * Take a CSV stream slot for this client, counting the start against its CSV budget. Returns
 * `{ release }` (call it exactly once when the stream is over; `createCsvStream` does) or the refusal:
 * 429 when this client already runs its share or has no CSV budget left, 503 when the server is full.
 * Do this BEFORE reading anything, so a refused request costs nothing.
 */
export function acquireCsvSlot(req: Request, now = Date.now()): { release: () => void } | Response {
  const { key, shared } = identify(req);
  const slotKey = shared ? undefined : key; // one shared key cannot be capped "per client"
  const limiter = csvStreams();
  const release = limiter.tryAcquire(slotKey);
  if (release === null) {
    return limiter.refusal(slotKey) === "client"
      ? tooManyRequests(10, `Only ${CSV_MAX_PER_CLIENT} CSV exports may run at once per client. Wait for one to finish.`)
      : serverBusy(5);
  }
  const csv = rateLimit(`apicsv:${key}`, scaled(API_CSV_BUDGET, shared), now);
  if (!csv.ok) {
    release();
    return tooManyRequests(csv.retryAfterSeconds, "Too many CSV exports. Please wait before exporting again, or page through the JSON records.");
  }
  return { release };
}

/** Test seam: how many CSV streams hold a slot right now. */
export function csvStreamsInFlight(): number {
  return csvStreams().inFlight;
}
