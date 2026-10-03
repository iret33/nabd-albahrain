import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ADMIN_COOKIE_NAME, createSession } from "@/lib/admin-session";
import {
  SYNC_API_FAILURE_LIMIT,
  authorizeSyncRequest,
  isSameOriginRequest,
  isSyncRequestAuthorized,
  safeEqual,
  syncAuthFailureResponse,
} from "@/lib/sync/auth";
import { resetRateLimit } from "@/lib/rate-limit";

const ADMIN_TOKEN = "admin-0123456789abcdef0123456789abcdef";
const SYNC_TOKEN = "sync-fedcba9876543210fedcba9876543210";
const ENV = { ADMIN_TOKEN, SYNC_TOKEN };

describe("safeEqual", () => {
  it("is true only for identical strings", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("", "")).toBe(true);
  });

  it("handles different lengths without throwing", () => {
    expect(safeEqual("short", "a-much-longer-secret-value")).toBe(false);
    expect(safeEqual("a-much-longer-secret-value", "short")).toBe(false);
    expect(safeEqual("", "x")).toBe(false);
  });

  it("handles non-ASCII input", () => {
    expect(safeEqual("رمز-سري", "رمز-سري")).toBe(true);
    expect(safeEqual("رمز-سري", "رمز-سرى")).toBe(false);
  });
});

describe("isSameOriginRequest", () => {
  const h = (init: Record<string, string>) => new Headers(init);

  it("trusts Sec-Fetch-Site when present", () => {
    expect(isSameOriginRequest(h({ "sec-fetch-site": "same-origin" }))).toBe(true);
    expect(isSameOriginRequest(h({ "sec-fetch-site": "same-site" }))).toBe(false);
    expect(isSameOriginRequest(h({ "sec-fetch-site": "cross-site" }))).toBe(false);
    expect(isSameOriginRequest(h({ "sec-fetch-site": "none" }))).toBe(false);
    // A forged matching Origin cannot override a browser-reported cross-site fetch.
    expect(
      isSameOriginRequest(h({ "sec-fetch-site": "cross-site", origin: "https://x.test", host: "x.test" })),
    ).toBe(false);
  });

  it("falls back to Origin host === Host", () => {
    expect(isSameOriginRequest(h({ origin: "https://data.example.com", host: "data.example.com" }))).toBe(true);
    expect(isSameOriginRequest(h({ origin: "http://localhost:3104", host: "localhost:3104" }))).toBe(true);
    expect(isSameOriginRequest(h({ origin: "https://DATA.example.com", host: "data.example.com" }))).toBe(true);
  });

  it("rejects a sibling subdomain, a different port, null/garbage/missing origin", () => {
    expect(isSameOriginRequest(h({ origin: "https://evil.example.com", host: "data.example.com" }))).toBe(false);
    expect(isSameOriginRequest(h({ origin: "http://localhost:3000", host: "localhost:3104" }))).toBe(false);
    expect(isSameOriginRequest(h({ origin: "null", host: "data.example.com" }))).toBe(false);
    expect(isSameOriginRequest(h({ origin: "not a url", host: "data.example.com" }))).toBe(false);
    expect(isSameOriginRequest(h({ host: "data.example.com" }))).toBe(false);
    expect(isSameOriginRequest(h({}))).toBe(false);
  });

  it("honours X-Forwarded-Host only when TRUST_PROXY=1", () => {
    const headers = h({ origin: "https://data.example.com", host: "127.0.0.1:3000", "x-forwarded-host": "data.example.com" });
    expect(isSameOriginRequest(headers, {})).toBe(false);
    expect(isSameOriginRequest(headers, { TRUST_PROXY: "1" })).toBe(true);
  });
});

describe("authorizeSyncRequest", () => {
  let n = 0;
  let ip: string;
  const req = (init: { method?: string; headers?: Record<string, string> } = {}) =>
    new Request("http://localhost:3104/api/sync", {
      method: init.method ?? "POST",
      headers: { "cf-connecting-ip": ip, ...init.headers },
    });

  beforeEach(() => {
    vi.stubEnv("TRUST_PROXY", "1");
    ip = `203.0.113.${++n}`;
    resetRateLimit(`sync-api:${ip}`);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("accepts the Bearer SYNC_TOKEN, rejects wrong/missing/ADMIN_TOKEN bearer", async () => {
    expect(await authorizeSyncRequest(req({ headers: { authorization: `Bearer ${SYNC_TOKEN}` } }), ENV)).toEqual({
      ok: true,
      via: "bearer",
    });
    expect(await isSyncRequestAuthorized(req({ headers: { authorization: `Bearer ${SYNC_TOKEN}x` } }))).toBe(false);
    expect((await authorizeSyncRequest(req(), ENV)).ok).toBe(false);
    expect((await authorizeSyncRequest(req({ headers: { authorization: `Bearer ${ADMIN_TOKEN}` } }), ENV)).ok).toBe(false);
    expect((await authorizeSyncRequest(req({ headers: { authorization: SYNC_TOKEN } }), ENV)).ok).toBe(false);
  });

  it("fails closed when SYNC_TOKEN is unset or empty", async () => {
    for (const env of [{}, { SYNC_TOKEN: "" }]) {
      expect((await authorizeSyncRequest(req({ headers: { authorization: "Bearer " } }), env)).ok).toBe(false);
      expect((await authorizeSyncRequest(req({ headers: { authorization: "Bearer undefined" } }), env)).ok).toBe(false);
    }
  });

  it("accepts a signed session cookie only on a same-origin state-changing request", async () => {
    const session = await createSession(ADMIN_TOKEN);
    const cookie = `${ADMIN_COOKIE_NAME}=${session}`;

    const sameOrigin = req({ headers: { cookie, "sec-fetch-site": "same-origin" } });
    expect(await authorizeSyncRequest(sameOrigin, ENV)).toEqual({ ok: true, via: "session" });

    const viaOrigin = req({ headers: { cookie, origin: "http://localhost:3104", host: "localhost:3104" } });
    expect((await authorizeSyncRequest(viaOrigin, ENV)).ok).toBe(true);

    // CSRF shapes: cross-site, sibling site, and no browser signal at all (curl with a stolen cookie).
    const csrfShapes: Array<Record<string, string>> = [
      { cookie, "sec-fetch-site": "cross-site" },
      { cookie, "sec-fetch-site": "same-site", origin: "https://sibling.example.com" },
      { cookie, origin: "https://sibling.example.com", host: "localhost:3104" },
      { cookie },
    ];
    for (const headers of csrfShapes) {
      expect((await authorizeSyncRequest(req({ headers }), ENV)).ok).toBe(false);
    }
  });

  it("allows the session cookie on safe methods without an Origin (status polling)", async () => {
    const session = await createSession(ADMIN_TOKEN);
    const get = req({ method: "GET", headers: { cookie: `${ADMIN_COOKIE_NAME}=${session}` } });
    expect((await authorizeSyncRequest(get, ENV)).ok).toBe(true);
  });

  it("rejects the legacy raw-token cookie, forged and expired sessions", async () => {
    const same = { "sec-fetch-site": "same-origin" };
    const legacy = req({ headers: { ...same, cookie: `admin_token=${ADMIN_TOKEN}` } });
    expect((await authorizeSyncRequest(legacy, ENV)).ok).toBe(false);
    const rawAsNewName = req({ headers: { ...same, cookie: `${ADMIN_COOKIE_NAME}=${ADMIN_TOKEN}` } });
    expect((await authorizeSyncRequest(rawAsNewName, ENV)).ok).toBe(false);

    const expired = await createSession(ADMIN_TOKEN, { now: Date.now() - 24 * 3600 * 1000 });
    expect((await authorizeSyncRequest(req({ headers: { ...same, cookie: `${ADMIN_COOKIE_NAME}=${expired}` } }), ENV)).ok).toBe(false);

    const otherKey = await createSession("z".repeat(40));
    expect((await authorizeSyncRequest(req({ headers: { ...same, cookie: `${ADMIN_COOKIE_NAME}=${otherKey}` } }), ENV)).ok).toBe(false);
  });

  it("answers 401 until the failure budget is spent, then 429 with Retry-After", async () => {
    const bad = () => authorizeSyncRequest(req({ headers: { authorization: "Bearer wrong" } }), ENV);
    for (let i = 0; i < SYNC_API_FAILURE_LIMIT.limit; i++) {
      expect(await bad()).toEqual({ ok: false, status: 401 });
    }
    const blocked = await bad();
    expect(blocked).toMatchObject({ ok: false, status: 429 });
    if (blocked.ok || blocked.status !== 429) throw new Error("expected 429");
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);

    // Even the right token is refused while locked out (that is what stops brute force)...
    const right = await authorizeSyncRequest(req({ headers: { authorization: `Bearer ${SYNC_TOKEN}` } }), ENV);
    expect(right).toMatchObject({ ok: false, status: 429 });

    // ...but another client is unaffected, and so is an admin session from the locked-out one.
    const other = new Request("http://localhost:3104/api/sync", {
      method: "POST",
      headers: { "cf-connecting-ip": `198.51.100.${n}`, authorization: `Bearer ${SYNC_TOKEN}` },
    });
    expect((await authorizeSyncRequest(other, ENV)).ok).toBe(true);
    const session = await createSession(ADMIN_TOKEN);
    const viaSession = req({ headers: { cookie: `${ADMIN_COOKIE_NAME}=${session}`, "sec-fetch-site": "same-origin" } });
    expect((await authorizeSyncRequest(viaSession, ENV)).ok).toBe(true);
  });

  it("builds JSON 401 and 429 responses", async () => {
    const r401 = syncAuthFailureResponse({ ok: false, status: 401 });
    expect(r401.status).toBe(401);
    expect(await r401.json()).toEqual({ error: "unauthorized" });
    const r429 = syncAuthFailureResponse({ ok: false, status: 429, retryAfterSeconds: 42 });
    expect(r429.status).toBe(429);
    expect(r429.headers.get("retry-after")).toBe("42");
    expect(await r429.json()).toMatchObject({ error: "rate_limited", retryAfterSeconds: 42 });
  });
});
