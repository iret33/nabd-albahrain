/**
 * Polite HTTP client for the data.gov.bh (OpenDataSoft Explore API v2.1)
 * ODS instance.
 *
 * Enforces every politeness rule from the project spec:
 *  - a global concurrency cap (default 3 in-flight requests)
 *  - a ~250ms stagger between request starts
 *  - exponential backoff with 2 retries on HTTP 429 / 5xx (or network error),
 *    honouring `Retry-After` (capped) when the portal sends one
 *  - a per-attempt deadline that covers the response BODY as well as the
 *    headers (a stalled or trickling export must not pin a concurrency slot
 *    and the sync lock forever)
 *  - a custom User-Agent on every request
 *
 * All knobs come from the validated `syncConfig` (see config.ts).
 */

import { syncConfig } from "./config";
import { HttpError, HttpTimeoutError, SyncAbortedError } from "./errors";

export { HttpError, HttpTimeoutError } from "./errors";

export const USER_AGENT = syncConfig.userAgent;
export const EXPORT_TIMEOUT_MS = syncConfig.exportTimeoutMs;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * Simple async gate: at most `concurrency` callers may be "inside" at once,
 * and successive admissions are spaced at least `delayMs` apart (measured
 * from when the previous caller was admitted, not when it finished) — this
 * gives the "concurrency 3, ~250ms between requests" behaviour from the
 * spec without serializing everything down to one request at a time.
 */
export class RateLimiter {
  private readonly concurrency: number;
  private readonly delayMs: number;
  private active = 0;
  private nextAdmitAt = 0;
  private readonly queue: Array<() => void> = [];

  constructor(concurrency: number, delayMs: number) {
    // Defensive on top of config.ts: a concurrency below 1 would make every
    // caller queue forever.
    this.concurrency = Number.isFinite(concurrency) && concurrency >= 1 ? Math.floor(concurrency) : 1;
    this.delayMs = Number.isFinite(delayMs) && delayMs >= 0 ? delayMs : 0;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    return new Promise((resolve) => {
      const attempt = () => {
        if (this.active >= this.concurrency) {
          this.queue.push(attempt);
          return;
        }
        this.active++;
        const now = Date.now();
        const admitAt = Math.max(now, this.nextAdmitAt);
        this.nextAdmitAt = admitAt + this.delayMs;
        const wait = admitAt - now;
        if (wait > 0) {
          setTimeout(resolve, wait);
        } else {
          resolve();
        }
      };
      attempt();
    });
  }

  private release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }
}

// Shared across the whole sync run so the cap applies globally, not per call
// site.
const limiter = new RateLimiter(syncConfig.concurrency, syncConfig.delayMs);

/**
 * `Retry-After` as milliseconds: either delta-seconds or an HTTP date.
 * Returns null when absent/unparseable. Capped so a hostile or odd header can
 * never stall a concurrency slot for long.
 */
export function parseRetryAfterMs(
  value: string | null | undefined,
  now = Date.now(),
  capMs = syncConfig.maxRetryAfterMs,
): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  let ms: number;
  if (/^\d{1,7}$/.test(trimmed)) {
    ms = Number.parseInt(trimmed, 10) * 1000;
  } else {
    // An HTTP-date always contains letters ("Sat, 03 Oct 2026 ..."); this
    // keeps "-5" and other junk from being read as a date.
    if (!/[A-Za-z]/.test(trimmed)) return null;
    const at = Date.parse(trimmed);
    if (Number.isNaN(at)) return null;
    ms = at - now;
  }
  return Math.min(capMs, Math.max(0, ms));
}

type Attempt =
  | { ok: true; body: unknown }
  | { ok: false; error: unknown; retryable: boolean; retryAfterMs: number | null };

/**
 * One fetch attempt. The abort timer is armed before the request and only
 * cleared in `finally`, AFTER the body has been read, so the deadline covers
 * the whole transfer.
 */
async function attemptOnce(url: string, timeoutMs: number, signal: AbortSignal | undefined, attempt: number): Promise<Attempt> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onExternalAbort = () => controller.abort();
  signal?.addEventListener("abort", onExternalAbort, { once: true });

  try {
    const res = await fetch(url, {
      headers: { "User-Agent": syncConfig.userAgent, Accept: "application/json" },
      signal: controller.signal,
    });

    if (res.status === 429 || res.status >= 500) {
      const retryAfterMs = parseRetryAfterMs(res.headers.get("retry-after"));
      await res.body?.cancel().catch(() => {});
      return {
        ok: false,
        error: new HttpError(`HTTP ${res.status} from ${url}`, res.status, url),
        retryable: true,
        retryAfterMs,
      };
    }
    if (!res.ok) {
      // 4xx other than 429: not retryable, fail fast.
      await res.body?.cancel().catch(() => {});
      return {
        ok: false,
        error: new HttpError(`HTTP ${res.status} from ${url}`, res.status, url),
        retryable: false,
        retryAfterMs: null,
      };
    }

    return { ok: true, body: await res.json() };
  } catch (err) {
    if (signal?.aborted) {
      return { ok: false, error: new SyncAbortedError("Sync aborted during a portal request"), retryable: false, retryAfterMs: null };
    }
    if (timedOut) {
      // A deadline that already burned a full attempt is retried at most once:
      // 3 x 120s on one export would pin a slot for six minutes.
      return {
        ok: false,
        error: new HttpTimeoutError(`Timed out after ${timeoutMs}ms: ${url}`, url),
        retryable: attempt < 1,
        retryAfterMs: null,
      };
    }
    return { ok: false, error: err, retryable: true, retryAfterMs: null };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onExternalAbort);
  }
}

/**
 * Fetch JSON from data.gov.bh, respecting concurrency/backoff/timeout, and
 * throwing HttpError on a non-2xx response that survives all retries.
 * `signal` aborts both a queued and an in-flight request (throws
 * SyncAbortedError).
 */
export async function politeFetchJson(
  url: string,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<unknown> {
  const timeoutMs = opts.timeoutMs ?? syncConfig.requestTimeoutMs;
  const signal = opts.signal;

  return limiter.run(async () => {
    let lastError: unknown;

    for (let attempt = 0; attempt <= syncConfig.maxRetries; attempt++) {
      if (signal?.aborted) throw new SyncAbortedError("Sync aborted before a portal request");

      const result = await attemptOnce(url, timeoutMs, signal, attempt);
      if (result.ok) return result.body;

      lastError = result.error;
      if (!result.retryable || attempt >= syncConfig.maxRetries) throw result.error;

      const backoff = syncConfig.retryBaseMs * 2 ** attempt;
      await sleep(result.retryAfterMs ?? backoff, signal);
    }

    // Unreachable, but keeps TypeScript happy.
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  });
}
