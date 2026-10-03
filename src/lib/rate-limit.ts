/**
 * Tiny in-memory fixed-window rate limiter. State lives on `globalThis` so it
 * survives Next.js module re-evaluation; it is per-process, which is exactly
 * right for this app's single-container deployment (put a Cloudflare rule in
 * front for anything stronger).
 */

export interface RateLimitResult {
  ok: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

const g = globalThis as unknown as { __nabdRateLimit?: Map<string, Bucket> };
const buckets = (g.__nabdRateLimit ??= new Map<string, Bucket>());
const MAX_KEYS = 10_000;

/** Count one hit for `key`; `ok` is false once `limit` hits land inside `windowMs`. */
export function rateLimit(key: string, opts: { limit: number; windowMs: number }, now = Date.now()): RateLimitResult {
  let bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    if (buckets.size >= MAX_KEYS) {
      for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
      if (buckets.size >= MAX_KEYS) buckets.clear(); // pathological: drop everything rather than grow forever
    }
    bucket = { count: 0, resetAt: now + opts.windowMs };
    buckets.set(key, bucket);
  }
  bucket.count += 1;
  const ok = bucket.count <= opts.limit;
  return {
    ok,
    remaining: Math.max(0, opts.limit - bucket.count),
    retryAfterSeconds: ok ? 0 : Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
  };
}

/**
 * Read a key's state WITHOUT counting a hit. For "N failures then lock out"
 * flows (login, sync-API 401s): peek before checking the credential, then call
 * `rateLimit()` only when it was wrong. `ok` is true while another attempt is
 * still allowed, i.e. fewer than `limit` hits are recorded in the live window.
 */
export function peekRateLimit(key: string, opts: { limit: number; windowMs: number }, now = Date.now()): RateLimitResult {
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) return { ok: true, remaining: opts.limit, retryAfterSeconds: 0 };
  const ok = bucket.count < opts.limit;
  return {
    ok,
    remaining: Math.max(0, opts.limit - bucket.count),
    retryAfterSeconds: ok ? 0 : Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
  };
}

/** Forget a key (e.g. after a successful login). */
export function resetRateLimit(key: string): void {
  buckets.delete(key);
}

/**
 * Best-effort client identity for rate limiting. Forwarding headers are only
 * trusted when TRUST_PROXY=1 (i.e. the app sits behind Cloudflare Tunnel /
 * a reverse proxy that sets them); otherwise everyone shares the "local" key.
 */
export function clientKey(headers: Headers): string {
  if (process.env.TRUST_PROXY === "1") {
    const ip = headers.get("cf-connecting-ip") ?? headers.get("x-forwarded-for")?.split(",")[0]?.trim();
    if (ip) return ip;
  }
  return "local";
}
