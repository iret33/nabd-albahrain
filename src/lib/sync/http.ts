/**
 * Polite HTTP client for the data.gov.bh (OpenDataSoft Explore API v2.1)
 * ODS instance.
 *
 * Enforces every politeness rule from the project spec:
 *  - a global concurrency cap (default 3 in-flight requests)
 *  - a ~250ms stagger between request starts
 *  - exponential backoff with 2 retries on HTTP 429 / 5xx (or network error)
 *  - a 120s timeout on export requests (shorter default elsewhere)
 *  - a custom User-Agent on every request
 */

export const USER_AGENT =
  "nabd-albahrain/1.0 (independent open-data dashboard; contact via hekkapp.com)";

const DEFAULT_TIMEOUT_MS = 30_000;
export const EXPORT_TIMEOUT_MS = 120_000;
const MAX_RETRIES = 2;
const RETRY_BASE_MS = 1_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Simple async gate: at most `concurrency` callers may be "inside" at once,
 * and successive admissions are spaced at least `delayMs` apart (measured
 * from when the previous caller was admitted, not when it finished) — this
 * gives the "concurrency 3, ~250ms between requests" behaviour from the
 * spec without serializing everything down to one request at a time.
 */
class RateLimiter {
  private readonly concurrency: number;
  private readonly delayMs: number;
  private active = 0;
  private nextAdmitAt = 0;
  private readonly queue: Array<() => void> = [];

  constructor(concurrency: number, delayMs: number) {
    this.concurrency = concurrency;
    this.delayMs = delayMs;
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
// site. SYNC_CONCURRENCY lets ops tune it via env without a code change;
// falls back to the spec's default of 3.
const concurrency = Number(process.env.SYNC_CONCURRENCY) || 3;
const limiter = new RateLimiter(concurrency, 250);

export class HttpError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly url?: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/**
 * Fetch JSON from data.gov.bh, respecting concurrency/backoff/timeout, and
 * throwing HttpError on a non-2xx response that survives all retries.
 */
export async function politeFetchJson(
  url: string,
  opts: { timeoutMs?: number } = {},
): Promise<unknown> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return limiter.run(async () => {
    let lastError: unknown;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const res = await fetch(url, {
          headers: { "User-Agent": USER_AGENT },
          signal: controller.signal,
        });
        clearTimeout(timeout);

        if (res.status === 429 || res.status >= 500) {
          lastError = new HttpError(
            `HTTP ${res.status} from ${url}`,
            res.status,
            url,
          );
          if (attempt < MAX_RETRIES) {
            await sleep(RETRY_BASE_MS * 2 ** attempt);
            continue;
          }
          throw lastError;
        }

        if (!res.ok) {
          // 4xx other than 429: not retryable, fail fast.
          throw new HttpError(`HTTP ${res.status} from ${url}`, res.status, url);
        }

        return await res.json();
      } catch (err) {
        clearTimeout(timeout);
        lastError = err;
        const retryable =
          err instanceof HttpError ? err.status === 429 || (err.status ?? 0) >= 500 : true;
        if (retryable && attempt < MAX_RETRIES) {
          await sleep(RETRY_BASE_MS * 2 ** attempt);
          continue;
        }
        throw err;
      }
    }

    // Unreachable, but keeps TypeScript happy.
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  });
}
