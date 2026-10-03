import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifySession } from "@/lib/admin-session";
import { LOGIN_FAILURE_DELAY_MS, LOGIN_FAILURE_LIMIT, attemptLogin } from "@/lib/admin/login";
import { resetRateLimit } from "@/lib/rate-limit";

const ADMIN_TOKEN = "9f2c1ab07d3e4568b1c0a7e2d4f65b83a1c9e07d2b4f6a8c0e1d3b5a7c9e2f40";
const env = { ADMIN_TOKEN };

let n = 0;
let client: string;
beforeEach(() => {
  client = `login-test-${++n}`;
  resetRateLimit(`admin-login:${client}`);
});
afterEach(() => vi.restoreAllMocks());

describe("attemptLogin", () => {
  it("accepts the right token and returns a verifiable signed session (not the token)", async () => {
    const out = await attemptLogin(ADMIN_TOKEN, client, { env, delayMs: 0 });
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    expect(out.session).not.toContain(ADMIN_TOKEN);
    expect(await verifySession(out.session, ADMIN_TOKEN)).toBe(true);
  });

  it("rejects wrong, empty and prefix-of-token submissions", async () => {
    for (const bad of ["", "wrong", ADMIN_TOKEN.slice(0, -1), ADMIN_TOKEN + "x", ADMIN_TOKEN.toUpperCase()]) {
      expect((await attemptLogin(bad, client, { env, delayMs: 0 })).kind).toBe("invalid");
      resetRateLimit(`admin-login:${client}`);
    }
  });

  it("fails closed (and says why on the server log) when ADMIN_TOKEN is unset", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await attemptLogin("anything", client, { env: {}, delayMs: 0 })).kind).toBe("invalid");
    expect((await attemptLogin("", client, { env: { ADMIN_TOKEN: "" }, delayMs: 0 })).kind).toBe("invalid");
    expect(spy).toHaveBeenCalled();
    expect(spy.mock.calls.flat().join(" ")).not.toContain("anything");
  });

  it("locks the client out after the failure budget, even for the correct token", async () => {
    for (let i = 0; i < LOGIN_FAILURE_LIMIT.limit; i++) {
      expect((await attemptLogin("nope", client, { env, delayMs: 0 })).kind).toBe("invalid");
    }
    expect((await attemptLogin("nope", client, { env, delayMs: 0 })).kind).toBe("rate");
    expect((await attemptLogin(ADMIN_TOKEN, client, { env, delayMs: 0 })).kind).toBe("rate");
    // another client is unaffected
    expect((await attemptLogin(ADMIN_TOKEN, `${client}-other`, { env, delayMs: 0 })).kind).toBe("ok");
  });

  it("unlocks after the window passes", async () => {
    const t = Date.now();
    for (let i = 0; i < LOGIN_FAILURE_LIMIT.limit; i++) await attemptLogin("nope", client, { env, delayMs: 0, now: t });
    expect((await attemptLogin(ADMIN_TOKEN, client, { env, delayMs: 0, now: t + 1000 })).kind).toBe("rate");
    const later = t + LOGIN_FAILURE_LIMIT.windowMs + 1;
    expect((await attemptLogin(ADMIN_TOKEN, client, { env, delayMs: 0, now: later })).kind).toBe("ok");
  });

  it("clears the failure counter on success", async () => {
    for (let i = 0; i < LOGIN_FAILURE_LIMIT.limit - 1; i++) await attemptLogin("nope", client, { env, delayMs: 0 });
    expect((await attemptLogin(ADMIN_TOKEN, client, { env, delayMs: 0 })).kind).toBe("ok");
    // a fresh full budget again
    for (let i = 0; i < LOGIN_FAILURE_LIMIT.limit; i++) {
      expect((await attemptLogin("nope", client, { env, delayMs: 0 })).kind).toBe("invalid");
    }
  });

  it("delays every failure by about 400ms but never a success", async () => {
    expect(LOGIN_FAILURE_DELAY_MS).toBeGreaterThanOrEqual(300);
    expect(LOGIN_FAILURE_DELAY_MS).toBeLessThanOrEqual(500);
    vi.useFakeTimers();
    try {
      const failing = attemptLogin("nope", client, { env });
      let settled = false;
      void failing.then(() => (settled = true));
      await vi.advanceTimersByTimeAsync(LOGIN_FAILURE_DELAY_MS - 50);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(100);
      expect(settled).toBe(true);

      const ok = await attemptLogin(ADMIN_TOKEN, client, { env });
      expect(ok.kind).toBe("ok");
    } finally {
      vi.useRealTimers();
    }
  });
});
