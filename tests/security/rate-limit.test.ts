import { afterEach, describe, expect, it, vi } from "vitest";
import { clientKey, peekRateLimit, rateLimit, resetRateLimit } from "@/lib/rate-limit";

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
  });

  it("prefers cf-connecting-ip, then the first x-forwarded-for hop, when trusted", () => {
    vi.stubEnv("TRUST_PROXY", "1");
    expect(clientKey(new Headers({ "cf-connecting-ip": "203.0.113.9", "x-forwarded-for": "198.51.100.1" }))).toBe("203.0.113.9");
    expect(clientKey(new Headers({ "x-forwarded-for": "198.51.100.1, 10.0.0.2" }))).toBe("198.51.100.1");
    expect(clientKey(new Headers())).toBe("local");
  });
});
