import { describe, expect, it } from "vitest";
import {
  ADMIN_SESSION_MAX_AGE_SECONDS,
  adminCookieOptions,
  createSession,
  readCookie,
  sessionSecretFromEnv,
  verifySession,
} from "@/lib/admin-session";

const SECRET = "a".repeat(8) + "b".repeat(8) + "c".repeat(8) + "d".repeat(8) + "e1";
const T0 = Date.UTC(2026, 9, 3, 12, 0, 0);

describe("admin session token", () => {
  it("round-trips and has the documented shape", async () => {
    const token = await createSession(SECRET, { now: T0 });
    expect(token).toMatch(/^\d+\.[0-9a-f]{32}\.[0-9a-f]{64}$/);
    const exp = Number(token.split(".")[0]);
    expect(exp).toBe(Math.floor(T0 / 1000) + ADMIN_SESSION_MAX_AGE_SECONDS);
    expect(await verifySession(token, SECRET, { now: T0 + 1000 })).toBe(true);
  });

  it("never embeds the secret and is unique per call", async () => {
    const a = await createSession(SECRET, { now: T0 });
    const b = await createSession(SECRET, { now: T0 });
    expect(a).not.toBe(b);
    expect(a.includes(SECRET)).toBe(false);
  });

  it("expires exactly at its expiry time", async () => {
    const token = await createSession(SECRET, { now: T0, maxAgeSeconds: 60 });
    expect(await verifySession(token, SECRET, { now: T0 + 59_000 })).toBe(true);
    expect(await verifySession(token, SECRET, { now: T0 + 60_000 })).toBe(false);
    expect(await verifySession(token, SECRET, { now: T0 + 3_600_000 })).toBe(false);
  });

  it("rejects a tampered expiry, nonce or MAC", async () => {
    const token = await createSession(SECRET, { now: T0, maxAgeSeconds: 60 });
    const [exp, nonce, mac] = token.split(".");
    const flip = (hex: string) => (hex[0] === "0" ? "1" : "0") + hex.slice(1);

    expect(await verifySession(`${Number(exp) + 3600}.${nonce}.${mac}`, SECRET, { now: T0 })).toBe(false);
    expect(await verifySession(`${exp}.${flip(nonce)}.${mac}`, SECRET, { now: T0 })).toBe(false);
    expect(await verifySession(`${exp}.${nonce}.${flip(mac)}`, SECRET, { now: T0 })).toBe(false);
    expect(await verifySession(`${exp}.${nonce}.${mac.slice(0, -2)}`, SECRET, { now: T0 })).toBe(false);
  });

  it("rejects a token signed with another secret (rotating ADMIN_TOKEN logs everyone out)", async () => {
    const token = await createSession(SECRET, { now: T0 });
    expect(await verifySession(token, SECRET + "x", { now: T0 })).toBe(false);
  });

  it("rejects missing secret, empty, malformed and legacy raw-token values", async () => {
    const token = await createSession(SECRET, { now: T0 });
    expect(await verifySession(token, undefined, { now: T0 })).toBe(false);
    expect(await verifySession(token, "", { now: T0 })).toBe(false);
    expect(await verifySession(undefined, SECRET)).toBe(false);
    expect(await verifySession(null, SECRET)).toBe(false);
    expect(await verifySession("", SECRET)).toBe(false);
    expect(await verifySession("not-a-token", SECRET)).toBe(false);
    expect(await verifySession("1.2.3", SECRET)).toBe(false);
    // The previous implementation stored the raw ADMIN_TOKEN as the cookie value.
    expect(await verifySession(SECRET, SECRET)).toBe(false);
    expect(await verifySession(`${"9".repeat(40)}.${"0".repeat(32)}.${"0".repeat(64)}`, SECRET)).toBe(false);
  });

  it("rejects a token that outlives the current policy even with a valid MAC", async () => {
    const long = await createSession(SECRET, { now: T0, maxAgeSeconds: ADMIN_SESSION_MAX_AGE_SECONDS * 4 });
    expect(await verifySession(long, SECRET, { now: T0 })).toBe(false);
  });

  it("refuses to mint a session without a secret", async () => {
    await expect(createSession(undefined)).rejects.toThrow(/SESSION_SECRET|ADMIN_TOKEN/);
    await expect(createSession("")).rejects.toThrow();
  });
});

describe("session secret + cookie helpers", () => {
  it("prefers SESSION_SECRET over ADMIN_TOKEN and ignores empties", () => {
    expect(sessionSecretFromEnv({ SESSION_SECRET: "s", ADMIN_TOKEN: "a" })).toBe("s");
    expect(sessionSecretFromEnv({ ADMIN_TOKEN: "a" })).toBe("a");
    expect(sessionSecretFromEnv({ SESSION_SECRET: "", ADMIN_TOKEN: "a" })).toBe("a");
    expect(sessionSecretFromEnv({})).toBeUndefined();
  });

  it("cookie attributes are httpOnly, strict, path=/ and 12h", () => {
    const o = adminCookieOptions();
    expect(o).toMatchObject({ httpOnly: true, sameSite: "strict", path: "/", maxAge: 12 * 3600 });
    expect(adminCookieOptions(0).maxAge).toBe(0);
  });

  it("readCookie picks the right cookie from a header", () => {
    expect(readCookie("a=1; nabd_admin=tok.en; b=2", "nabd_admin")).toBe("tok.en");
    expect(readCookie("nabd_admin_other=x; nabd_admin=y", "nabd_admin")).toBe("y");
    expect(readCookie("a=1", "nabd_admin")).toBeUndefined();
    expect(readCookie("garbage", "nabd_admin")).toBeUndefined();
    expect(readCookie(null, "nabd_admin")).toBeUndefined();
  });
});
