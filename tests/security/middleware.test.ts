import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { ADMIN_COOKIE_NAME, createSession } from "@/lib/admin-session";
import { config, middleware } from "@/middleware";

const ADMIN_TOKEN = "9f2c1ab07d3e4568b1c0a7e2d4f65b83a1c9e07d2b4f6a8c0e1d3b5a7c9e2f40";

beforeEach(() => {
  vi.stubEnv("ADMIN_TOKEN", ADMIN_TOKEN);
  vi.stubEnv("SESSION_SECRET", "");
  vi.stubEnv("TRUST_PROXY", "0");
});
afterEach(() => vi.unstubAllEnvs());

function req(url: string, headers: Record<string, string> = {}, cookie?: string): NextRequest {
  const h = new Headers(headers);
  if (cookie) h.set("cookie", `${ADMIN_COOKIE_NAME}=${cookie}`);
  return new NextRequest(url, { headers: h });
}

const isPassThrough = (res: Response) => res.headers.get("x-middleware-next") === "1";
const rewriteTarget = (res: Response) => res.headers.get("x-middleware-rewrite");

/** Next compiles `matcher` sources with path-to-regexp; for plain `(...)` groups that is the same as anchoring the source. */
function matches(path: string): boolean {
  return config.matcher.some((source) => new RegExp(`^${source.replace("/:path*", "(?:/.*)?")}$`).test(path));
}

describe("middleware: ?constructor= (Next 15 searchParams Promise crash)", () => {
  it.each([
    ["/search?constructor=1", "/search"],
    ["/search?constructor=", "/search"],
    ["/search?constructor", "/search"],
    ["/search?%63onstructor=1", "/search"],
    ["/search?q=%D9%85%D9%8A%D8%A7%D9%87&constructor=1&page=2", "/search?q=%D9%85%D9%8A%D8%A7%D9%87&page=2"],
    ["/search?constructor=1&constructor=2&a=b", "/search?a=b"],
    ["/categories/Health?constructor=x", "/categories/Health"],
    ["/publishers/some-authority?constructor=x", "/publishers/some-authority"],
    ["/dataset/air-quality-stations?constructor=x", "/dataset/air-quality-stations"],
    ["/updates?constructor=1", "/updates"],
    ["/admin/login?constructor=1", "/admin/login"],
  ])("rewrites %s to the same page without the key", async (url, expected) => {
    const res = await middleware(req(`http://localhost:3000${url}`));
    expect(res.status).toBe(200);
    const target = new URL(rewriteTarget(res)!);
    expect(target.pathname + target.search).toBe(expected);
  });

  it("leaves every other key alone, including other Object.prototype names", async () => {
    for (const key of ["__proto__", "then", "toString", "valueOf", "hasOwnProperty", "q", "Constructor", "constructors"]) {
      const res = await middleware(req(`http://localhost:3000/search?${key}=1`));
      expect(isPassThrough(res), key).toBe(true);
    }
  });

  it("passes plain page requests straight through", async () => {
    for (const url of ["/", "/search", "/search?q=a", "/dataset/x?page=2", "/about"]) {
      expect(isPassThrough(await middleware(req(`http://localhost:3000${url}`))), url).toBe(true);
    }
  });

  it("also strips the key for a logged-in admin, and still guards a logged-out one", async () => {
    const session = await createSession(ADMIN_TOKEN);
    const ok = await middleware(req("http://localhost:3000/admin?constructor=1", {}, session));
    expect(new URL(rewriteTarget(ok)!).pathname).toBe("/admin");
    expect(new URL(rewriteTarget(ok)!).search).toBe("");

    const out = await middleware(req("http://localhost:3000/admin?constructor=1"));
    expect(out.status).toBe(307);
    expect(new URL(out.headers.get("location")!).pathname).toBe("/admin/login");
  });

  it("matches every page route (including empty-valued keys) and no asset or API route", () => {
    for (const p of ["/", "/search", "/updates", "/dataset/x", "/categories/Health", "/publishers/p", "/admin", "/admin/login"]) {
      expect(matches(p), p).toBe(true);
    }
    for (const p of ["/api/v1/datasets", "/api/sync", "/_next/static/chunks/a.js", "/_next/image"]) {
      expect(matches(p), p).toBe(false);
    }
    // A `has` query condition would skip the empty-valued forms (Next treats "" as absent).
    expect(JSON.stringify(config.matcher)).not.toContain('"has"');
  });
});

describe("middleware: /admin guard", () => {
  it("lets /admin/login through without a session", async () => {
    expect(isPassThrough(await middleware(req("http://localhost:3000/admin/login")))).toBe(true);
  });

  it("accepts a valid signed session and rejects forged, expired and legacy raw-token cookies", async () => {
    const session = await createSession(ADMIN_TOKEN);
    expect(isPassThrough(await middleware(req("http://localhost:3000/admin", {}, session)))).toBe(true);

    for (const bad of [
      "",
      ADMIN_TOKEN,
      session.slice(0, -1) + (session.endsWith("0") ? "1" : "0"),
      await createSession(ADMIN_TOKEN, { now: Date.now() - 24 * 60 * 60 * 1000 }),
      await createSession("another-secret-another-secret-another-secret"),
    ]) {
      const res = await middleware(req("http://localhost:3000/admin", {}, bad));
      expect(res.status).toBe(307);
      expect(new URL(res.headers.get("location")!).pathname).toBe("/admin/login");
    }
  });

  it("guards nested admin paths too", async () => {
    const res = await middleware(req("http://localhost:3000/admin/anything/else?x=1"));
    expect(res.status).toBe(307);
  });
});

describe("middleware: login redirect is built from the Host the visitor used, not the bind address", () => {
  // `new URL("/admin/login", req.url)` came out as https://localhost:3204/admin/login for a
  // loopback-bound standalone server behind cloudflared; Next reports req.url from its bind
  // address (127.0.0.1 -> localhost).
  it("uses Host and the forwarded proto even when req.url says localhost", async () => {
    vi.stubEnv("TRUST_PROXY", "1");
    const res = await middleware(
      req("http://localhost:3204/admin", {
        host: "data.hekkapp.com",
        "x-forwarded-proto": "https",
        "x-forwarded-host": "data.hekkapp.com",
      }),
    );
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://data.hekkapp.com/admin/login");
  });

  it("keeps the visitor's port and ignores forwarded headers unless TRUST_PROXY=1", async () => {
    const res = await middleware(req("http://localhost:3204/admin", { host: "192.168.1.20:8080", "x-forwarded-host": "evil.example" }));
    expect(res.headers.get("location")).toBe("http://192.168.1.20:8080/admin/login");
  });

  it("leaves the non-loopback bind path alone: the redirect stays on req.url's own origin so Next can relativize it (Docker's 0.0.0.0)", async () => {
    // Next turns an absolute Location equal to its own origin into a relative one, which is right whatever
    // scheme/host the visitor used; rebuilding it from Host/X-Forwarded-Proto would only add ways to be wrong.
    vi.stubEnv("TRUST_PROXY", "1");
    for (const bind of ["http://0.0.0.0:3000", "http://192.168.1.20:3000", "http://app:3000", "https://0.0.0.0:3000"]) {
      const res = await middleware(
        req(`${bind}/admin`, { host: "data.hekkapp.com", "x-forwarded-proto": "https", "x-forwarded-host": "data.hekkapp.com" }),
      );
      expect(res.headers.get("location"), bind).toBe(`${bind}/admin/login`);
    }
  });

  it("falls back to the request URL when Host is missing or malformed (never a thrown Invalid URL)", async () => {
    for (const host of ["", "bad host/../x", "user@evil.example", "evil.example:99999", "a..b"]) {
      const res = await middleware(req("http://localhost:3204/admin", host ? { host } : {}));
      expect(res.status, host).toBe(307);
      expect(new URL(res.headers.get("location")!).pathname, host).toBe("/admin/login");
      expect(res.headers.get("location"), host).not.toContain("evil");
    }
  });
});
