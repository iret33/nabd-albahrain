/**
 * Tiny in-memory fixed-window rate limiter. State lives on `globalThis` so it
 * survives Next.js module re-evaluation; it is per-process, which is exactly
 * right for this app's single-container deployment (put a Cloudflare rule in
 * front for anything stronger).
 */

import { isIP } from "node:net";
import { trustProxyEnabled } from "@/lib/env";

export interface RateLimitResult {
  ok: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

interface Bucket {
  count: number;
  resetAt: number;
  /** The limit the bucket was created with: a bucket at or over it is a live lockout. */
  limit: number;
}

const g = globalThis as unknown as { __nabdRateLimit?: Map<string, Bucket> };
const buckets = (g.__nabdRateLimit ??= new Map<string, Bucket>());
const MAX_KEYS = 10_000;

/**
 * Make room for one more key. The map is bounded so a flood of distinct keys
 * cannot grow it forever, but wiping it wholesale would also wipe every live
 * lockout (an attacker could flush its own lock by flooding keys), so:
 *  1. expired buckets go first;
 *  2. then buckets that are NOT locked (still under their limit), oldest first;
 *  3. only if everything left is a live lockout, the ones closest to expiring.
 * Step 3 fails open for the soonest-to-expire locks rather than closed for
 * every new client; with validated, /64-collapsed client keys it takes 10,000
 * genuinely distinct sources each exhausting a limit to get there.
 */
function makeRoom(now: number): void {
  for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
  if (buckets.size < MAX_KEYS) return;

  const evict = Math.ceil(MAX_KEYS / 10);
  let removed = 0;
  for (const [k, b] of buckets) {
    if (b.count < b.limit) {
      buckets.delete(k);
      if (++removed >= evict) return;
    }
  }
  if (buckets.size < MAX_KEYS) return;
  const soonest = [...buckets.entries()].sort((a, b) => a[1].resetAt - b[1].resetAt).slice(0, evict);
  for (const [k] of soonest) buckets.delete(k);
}

/** Count one hit for `key`; `ok` is false once `limit` hits land inside `windowMs`. */
export function rateLimit(key: string, opts: { limit: number; windowMs: number }, now = Date.now()): RateLimitResult {
  let bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    if (buckets.size >= MAX_KEYS) makeRoom(now);
    bucket = { count: 0, resetAt: now + opts.windowMs, limit: opts.limit };
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

/** How many keys the limiter holds right now (tests, diagnostics). */
export function rateLimitKeyCount(): number {
  return buckets.size;
}

/** The longest textual IP address is 45 characters (IPv4-mapped IPv6 with a full IPv4 tail). */
const MAX_IP_TEXT_LENGTH = 45;

/** Eight 16-bit groups of a valid IPv6 literal (any `::` compression, optional dotted IPv4 tail), or null. */
function ipv6Groups(text: string): number[] | null {
  let head = text;
  let tail: number[] = [];
  const dotted = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number);
    tail = [(a << 8) | b, (c << 8) | d];
    head = text.slice(0, dotted.index) + "0:0"; // two placeholder groups, replaced below
  }
  const halves = head.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string): number[] | null => {
    if (part === "") return [];
    const out: number[] = [];
    for (const group of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
      out.push(parseInt(group, 16));
    }
    return out;
  };
  const left = parse(halves[0]);
  const right = halves.length === 2 ? parse(halves[1]) : [];
  if (!left || !right) return null;
  let groups: number[];
  if (halves.length === 2) {
    const missing = 8 - left.length - right.length;
    if (missing < 1) return null;
    groups = [...left, ...new Array<number>(missing).fill(0), ...right];
  } else {
    groups = left;
  }
  if (groups.length !== 8) return null;
  if (dotted) groups = [...groups.slice(0, 6), ...tail];
  return groups;
}

/**
 * A rate-limit key for a client address, or null when `raw` is not a clean IP
 * literal. Rejects (never truncates: that would make distinct clients collide)
 * anything that is not exactly an IPv4/IPv6 address. Normalised so one client
 * cannot split itself across spellings: IPv6 is lowercased, an IPv4-mapped
 * address (`::ffff:203.0.113.9`) becomes the plain IPv4, and any other IPv6
 * address collapses to its /64, because a single subscriber owns a whole /64
 * and could otherwise rotate through 2^64 addresses for a fresh bucket each
 * time (clients that share a /64 share a lockout; that is the accepted cost).
 */
export function normalizeClientIp(raw: string | null | undefined): string | null {
  const text = raw?.trim().toLowerCase();
  if (!text || text.length > MAX_IP_TEXT_LENGTH) return null;
  const family = isIP(text);
  if (family === 4) return text;
  if (family !== 6 || text.includes("%")) return null;
  const groups = ipv6Groups(text);
  if (!groups) return null;
  if (groups.slice(0, 5).every((x) => x === 0) && groups[5] === 0xffff) {
    return `${groups[6] >> 8}.${groups[6] & 255}.${groups[7] >> 8}.${groups[7] & 255}`;
  }
  return `${groups.slice(0, 4).map((x) => x.toString(16)).join(":")}::/64`;
}

/**
 * Best-effort client identity for rate limiting. With TRUST_PROXY=1 the app
 * sits behind Cloudflare Tunnel, which overwrites `CF-Connecting-IP` on every
 * request, so ONLY that header is believed (and only when it is a clean IP,
 * see normalizeClientIp). `X-Forwarded-For` is deliberately NOT used: its
 * leftmost entry is whatever the client sent, and the rightmost is the
 * proxy's own address as soon as a second proxy sits in front, which would put
 * every visitor in one bucket. Anything else (TRUST_PROXY unset, `0`, or a
 * missing/garbled header) shares the single "local" key.
 */
export function clientKey(headers: Headers): string {
  if (trustProxyEnabled()) {
    const ip = normalizeClientIp(headers.get("cf-connecting-ip"));
    if (ip) return ip;
  }
  return "local";
}
