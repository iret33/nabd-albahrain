import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOGIN_ERROR_MESSAGES, WRONG_TOKEN_MESSAGE, loginErrorMessage } from "@/lib/admin/login-errors";

/**
 * `loginAction` with `next/headers`, `next/navigation` and the throttle/compare
 * step mocked: this pins WHEN the action refuses to try (plain http in
 * production) and that it never weakens the cookie, not the login maths (see
 * login.test.ts for that).
 */

const state = vi.hoisted(() => ({
  headers: new Headers(),
  cookieSet: vi.fn(),
  attempt: vi.fn(),
}));

vi.mock("next/headers", () => ({
  headers: async () => state.headers,
  cookies: async () => ({ set: state.cookieSet }),
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT ${url}`);
  },
}));
vi.mock("@/lib/admin/login", () => ({ attemptLogin: state.attempt }));

import { loginAction } from "@/app/admin/login/actions";

const form = (token: string) => {
  const f = new FormData();
  f.set("token", token);
  return f;
};

beforeEach(() => {
  state.headers = new Headers();
  state.cookieSet.mockReset();
  state.attempt.mockReset();
  state.attempt.mockResolvedValue({ kind: "invalid" });
  vi.stubEnv("TRUST_PROXY", "1");
  vi.stubEnv("NODE_ENV", "production");
});
afterEach(() => vi.unstubAllEnvs());

describe("loginAction over plain http in production", () => {
  it("explains instead of half-logging in: ?error=insecure, no throttle spend, no token compare, no cookie", async () => {
    state.headers = new Headers({ host: "192.0.2.2:3000", "x-forwarded-proto": "http" });
    await expect(loginAction(form("whatever"))).rejects.toThrow("REDIRECT /admin/login?error=insecure");
    expect(state.attempt).not.toHaveBeenCalled();
    expect(state.cookieSet).not.toHaveBeenCalled();
  });

  it("does the same for the correct token (never reveals that it was right)", async () => {
    state.attempt.mockResolvedValue({ kind: "ok", session: "signed" });
    state.headers = new Headers({ host: "data.hekkapp.com", "x-forwarded-proto": "http" });
    await expect(loginAction(form("the-right-token"))).rejects.toThrow("?error=insecure");
    expect(state.cookieSet).not.toHaveBeenCalled();
  });

  it("does NOT block on a missing X-Forwarded-Proto (a TLS-terminating proxy that does not forward it must keep working)", async () => {
    state.headers = new Headers({ host: "data.hekkapp.com" });
    await expect(loginAction(form("x"))).rejects.toThrow("REDIRECT /admin/login?error=1");
    expect(state.attempt).toHaveBeenCalledTimes(1);
  });

  it("does not block https, or a loopback host reached over http (a secure context)", async () => {
    for (const headers of [
      { host: "data.hekkapp.com", "x-forwarded-proto": "https" },
      { host: "localhost:3000", "x-forwarded-proto": "http" },
      { host: "127.0.0.1:3000", "x-forwarded-proto": "http" },
    ]) {
      state.attempt.mockClear();
      state.headers = new Headers(headers);
      await expect(loginAction(form("x"))).rejects.toThrow("REDIRECT /admin/login?error=1");
      expect(state.attempt).toHaveBeenCalledTimes(1);
    }
  });

  it("ignores a forged X-Forwarded-Proto when TRUST_PROXY is off", async () => {
    vi.stubEnv("TRUST_PROXY", "0");
    state.headers = new Headers({ host: "data.hekkapp.com", "x-forwarded-proto": "http" });
    await expect(loginAction(form("x"))).rejects.toThrow("REDIRECT /admin/login?error=1");
  });

  it("still sets the Secure __Host- style cookie on success (the cookie is never weakened)", async () => {
    state.attempt.mockResolvedValue({ kind: "ok", session: "signed-session" });
    state.headers = new Headers({ host: "data.hekkapp.com", "x-forwarded-proto": "https" });
    await expect(loginAction(form("x"))).rejects.toThrow("REDIRECT /admin");
    expect(state.cookieSet).toHaveBeenCalledTimes(1);
    const [, value, options] = state.cookieSet.mock.calls[0];
    expect(value).toBe("signed-session");
    expect(options).toMatchObject({ httpOnly: true, secure: true, sameSite: "strict", path: "/" });
  });
});

describe("loginAction outside production (next dev, unprefixed non-Secure cookie)", () => {
  it("does not apply the insecure check", async () => {
    vi.stubEnv("NODE_ENV", "development");
    state.headers = new Headers({ host: "192.0.2.2:3000", "x-forwarded-proto": "http" });
    await expect(loginAction(form("x"))).rejects.toThrow("REDIRECT /admin/login?error=1");
    expect(state.attempt).toHaveBeenCalledTimes(1);
  });
});

describe("loginErrorMessage", () => {
  it("gives every redirect code its own message and reserves 'wrong token' for the rest", () => {
    expect(loginErrorMessage(undefined)).toBeNull();
    expect(loginErrorMessage("")).toBeNull();
    for (const code of ["rate", "insecure", "session"] as const) {
      expect(loginErrorMessage(code)).toBe(LOGIN_ERROR_MESSAGES[code]);
      expect(loginErrorMessage(code)).not.toBe(WRONG_TOKEN_MESSAGE);
    }
    expect(new Set(Object.values(LOGIN_ERROR_MESSAGES)).size).toBe(3);
    expect(loginErrorMessage("1")).toBe(WRONG_TOKEN_MESSAGE);
    expect(loginErrorMessage("anything-else")).toBe(WRONG_TOKEN_MESSAGE);
  });

  it("is not fooled by Object.prototype names or repeated keys", () => {
    for (const code of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      expect(loginErrorMessage(code)).toBe(WRONG_TOKEN_MESSAGE);
    }
    expect(loginErrorMessage(["insecure", "rate"])).toBe(LOGIN_ERROR_MESSAGES.insecure);
  });

  it("the insecure and session messages say why: HTTPS / localhost", () => {
    expect(LOGIN_ERROR_MESSAGES.insecure).toMatch(/HTTPS|https/);
    expect(LOGIN_ERROR_MESSAGES.insecure).toContain("localhost");
    expect(LOGIN_ERROR_MESSAGES.session).toContain("https://");
  });
});
