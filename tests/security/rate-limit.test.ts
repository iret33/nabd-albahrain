import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clientKey,
  normalizeClientIp,
  peekRateLimit,
  rateLimit,
  rateLimitKeyCount,
  resetRateLimit,
} from "@/lib/rate-limit";

const opts = { limit: 3, windowMs: 1000 };

describe("rateLimit (existing contract, still honoured)", () => {
  it("counts hits and blocks past the limit, then recovers after the window", () => {
    const key = "rl:basic";
    const t = 1_000_000;
    expect(rateLimit(key, opts, t)).toMatchObject({ ok: true, remaining: 2 });
    expect(rateLimit(key, opts, t + 1)).toMatchObject({ ok: true, remaining: 1 });
    expect(rateLimit(key, opts, t + 2)).toMatchObject({ ok: true, remaining: 0 });
    const blocked = rateLimit(key, opts, t + 3);
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(rateLimit(key, opts, t + 1001).ok).toBe(true);
  });

  it("resetRateLimit forgets a key", () => {
    const key = "rl:reset";
    for (let i = 0; i < 5; i++) rateLimit(key, opts, 5);
    expect(rateLimit(key, opts, 6).ok).toBe(false);
    resetRateLimit(key);
    expect(rateLimit(key, opts, 7).ok).toBe(true);
  });
});

describe("peekRateLimit", () => {
  it("does not count, so peeking never exhausts the budget", () => {
    const key = "rl:peek-nocount";
    for (let i = 0; i < 50; i++) expect(peekRateLimit(key, opts, 10).ok).toBe(true);
    expect(rateLimit(key, opts, 10)).toMatchObject({ ok: true, remaining: 2 });
  });

  it("flips to blocked exactly when `limit` failures are recorded, with a Retry-After", () => {
    const key = "rl:peek-lockout";
    const t = 2_000_000;
    for (let i = 0; i < opts.limit; i++) {
      expect(peekRateLimit(key, opts, t).ok).toBe(true);
      rateLimit(key, opts, t);
    }
    const gate = peekRateLimit(key, opts, t + 200);
    expect(gate.ok).toBe(false);
    expect(gate.remaining).toBe(0);
    expect(gate.retryAfterSeconds).toBe(1);
  });

  it("unlocks when the window expires and when the key is reset", () => {
    const key = "rl:peek-expiry";
    for (let i = 0; i < opts.limit; i++) rateLimit(key, opts, 100);
    expect(peekRateLimit(key, opts, 500).ok).toBe(false);
    expect(peekRateLimit(key, opts, 100 + opts.windowMs).ok).toBe(true);

    for (let i = 0; i < opts.limit; i++) rateLimit(key, opts, 5000);
    expect(peekRateLimit(key, opts, 5001).ok).toBe(false);
    resetRateLimit(key);
    expect(peekRateLimit(key, opts, 5002).ok).toBe(true);
  });

  it("keeps keys independent", () => {
    for (let i = 0; i < opts.limit; i++) rateLimit("rl:a", opts, 1);
    expect(peekRateLimit("rl:a", opts, 2).ok).toBe(false);
    expect(peekRateLimit("rl:b", opts, 2).ok).toBe(true);
  });
});

describe("clientKey", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("ignores forwarding headers unless TRUST_PROXY=1", () => {
    const h = new Headers({ "cf-connecting-ip": "203.0.113.9", "x-forwarded-for": "198.51.100.1" });
    expect(clientKey(h)).toBe("local");
    vi.stubEnv("TRUST_PROXY", "0");
    expect(clientKey(h)).toBe("local");
    for (const loose of ["true", "yes", "on", "2"]) {
      vi.stubEnv("TRUST_PROXY", loose);
      expect(clientKey(h), loose).toBe("local"); // never coerced into trusting spoofable headers
    }
  });

  it("believes ONLY cf-connecting-ip when trusted: X-Forwarded-For (attacker-controlled leftmost entry) is ignored", () => {
    vi.stubEnv("TRUST_PROXY", "1");
    expect(clientKey(new Headers({ "cf-connecting-ip": "203.0.113.9", "x-forwarded-for": "198.51.100.1" }))).toBe("203.0.113.9");
    // the old fallback: leftmost XFF entry, rotated by the attacker to dodge every limit
    for (let i = 0; i < 5; i++) {
      expect(clientKey(new Headers({ "x-forwarded-for": `9.9.9.${i}, 2.2.2.2` }))).toBe("local");
    }
    expect(clientKey(new Headers({ "x-forwarded-for": "198.51.100.1, 10.0.0.2" }))).toBe("local");
    expect(clientKey(new Headers())).toBe("local");
  });

  it("falls back to the shared key for a cf-connecting-ip that is not a clean IP address (never truncated)", () => {
    vi.stubEnv("TRUST_PROXY", "1");
    for (const junk of ["not-an-ip", "203.0.113.9, 1.1.1.1", "203.0.113.256", "1".repeat(500), "fe80::1%eth0", "<script>", "::g"]) {
      expect(clientKey(new Headers({ "cf-connecting-ip": junk })), junk).toBe("local");
    }
  });

  it("tolerates surrounding whitespace in TRUST_PROXY", () => {
    vi.stubEnv("TRUST_PROXY", " 1 ");
    expect(clientKey(new Headers({ "cf-connecting-ip": "203.0.113.9" }))).toBe("203.0.113.9");
  });
});

describe("normalizeClientIp", () => {
  it("keeps IPv4 as is and lowercases/validates", () => {
    expect(normalizeClientIp("203.0.113.9")).toBe("203.0.113.9");
    expect(normalizeClientIp(" 203.0.113.9 ")).toBe("203.0.113.9");
    expect(normalizeClientIp(undefined)).toBeNull();
    expect(normalizeClientIp(null)).toBeNull();
    expect(normalizeClientIp("")).toBeNull();
  });

  it("collapses IPv6 to its /64, so rotating through a subscriber's addresses does not buy fresh buckets", () => {
    const a = normalizeClientIp("2001:db8:abcd:12::1");
    const b = normalizeClientIp("2001:db8:abcd:12:ffff:ffff:ffff:ffff");
    const c = normalizeClientIp("2001:0DB8:ABCD:0012:0:0:0:5");
    expect(a).toBe("2001:db8:abcd:12::/64");
    expect(b).toBe(a);
    expect(c).toBe(a);
    expect(normalizeClientIp("2001:db8:abcd:13::1")).not.toBe(a); // another /64 stays separate
    expect(normalizeClientIp("::1")).toBe("0:0:0:0::/64");
  });

  it("unmaps IPv4-mapped IPv6 to the plain IPv4 so one client cannot split across spellings", () => {
    expect(normalizeClientIp("::ffff:203.0.113.9")).toBe("203.0.113.9");
    expect(normalizeClientIp("::FFFF:cb00:7109")).toBe("203.0.113.9");
    expect(normalizeClientIp("0:0:0:0:0:ffff:203.0.113.9")).toBe("203.0.113.9");
  });

  it("rejects anything that is not exactly one IP literal", () => {
    for (const bad of ["203.0.113", "203.0.113.9:8080", "[2001:db8::1]", "fe80::1%eth0", "2001:db8::1::2", "a".repeat(46), "0x7f.0.0.1", "203.0.113.9/24"]) {
      expect(normalizeClientIp(bad), bad).toBeNull();
    }
  });
});

describe("the key map is bounded without wiping live lockouts (clientkey-trusts-leftmost-xff)", () => {
  const lock = { limit: 2, windowMs: 60_000 };

  it("a flood of one-off keys cannot evict a locked client", () => {
    const t = 10_000_000;
    rateLimit("flood:victim", lock, t);
    rateLimit("flood:victim", lock, t);
    expect(peekRateLimit("flood:victim", lock, t).ok).toBe(false); // locked out
    for (let i = 0; i < 25_000; i++) rateLimit(`flood:attacker-${i}`, lock, t + 1);
    expect(rateLimitKeyCount()).toBeLessThanOrEqual(10_000);
    expect(peekRateLimit("flood:victim", lock, t + 2).ok).toBe(false); // still locked
    expect(rateLimit("flood:victim", lock, t + 3).ok).toBe(false);
  });

  it("when every bucket is a live lockout the soonest-to-expire go first, and the map stays bounded", () => {
    const t = 20_000_000;
    for (let i = 0; i < 10_050; i++) {
      rateLimit(`locked:${i}`, lock, t + i);
      rateLimit(`locked:${i}`, lock, t + i);
    }
    expect(rateLimitKeyCount()).toBeLessThanOrEqual(10_000);
    // the newest lockouts survive; the oldest (closest to expiring) were the ones given up
    expect(peekRateLimit("locked:10049", lock, t + 20_000).ok).toBe(false);
    expect(peekRateLimit("locked:0", lock, t + 20_000).ok).toBe(true);
  });

  it("expired buckets are collected first", () => {
    const t = 30_000_000;
    for (let i = 0; i < 6_000; i++) rateLimit(`old:${i}`, { limit: 1, windowMs: 10 }, t);
    for (let i = 0; i < 6_000; i++) rateLimit(`new:${i}`, lock, t + 1_000);
    expect(rateLimitKeyCount()).toBeLessThanOrEqual(10_000);
    expect(peekRateLimit("new:5999", lock, t + 1_001).remaining).toBe(1); // nothing live was dropped
  });
});
