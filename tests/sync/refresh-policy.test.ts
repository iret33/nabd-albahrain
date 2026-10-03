import { describe, expect, it } from "vitest";
import { isAllowedOrigin, isPublicDatasetId, parseRefreshBody } from "@/lib/sync/refresh-policy";
import { cooldownUntil, isStale } from "@/lib/sync/freshness";
import { readTextCapped } from "@/lib/sync/body";

describe("parseRefreshBody", () => {
  it("accepts the two documented shapes", () => {
    expect(parseRefreshBody('{"scope":"catalog"}')).toEqual({ ok: true, body: { scope: "catalog" } });
    expect(parseRefreshBody('{"scope":"dataset","id":"seaports"}')).toEqual({
      ok: true,
      body: { scope: "dataset", id: "seaports" },
    });
  });

  it("rejects everything else, including any attempt to force", () => {
    for (const bad of [
      "",
      "not json",
      "null",
      "[]",
      '{"scope":"all"}',
      '{"scope":"catalog","force":true}',
      '{"scope":"dataset"}',
      '{"scope":"dataset","id":""}',
      '{"scope":"dataset","id":5}',
      '{"scope":"dataset","id":"x","force":1}',
      `{"scope":"dataset","id":"${"x".repeat(301)}"}`,
      " ".repeat(2000) + '{"scope":"catalog"}',
    ]) {
      expect(parseRefreshBody(bad).ok, bad.slice(0, 40)).toBe(false);
    }
  });
});

describe("dataset ids from the outside world (public-endpoints-500-on-nul-dataset-id)", () => {
  const body = (id: string) => JSON.stringify({ scope: "dataset", id });

  it("isPublicDatasetId rejects NUL, control characters, lone surrogates and over-long ids, and accepts real ones", () => {
    for (const bad of ["a\u0000b", "\u0000", "a\nb", "a\u007fb", "a\ud800b", "\udc00x", "x\ud83d", "x".repeat(201), "", 7, null, undefined]) {
      expect(isPublicDatasetId(bad), JSON.stringify(bad)).toBe(false);
    }
    for (const good of ["seaports", "population-by-nationality", "x".repeat(200), "dataset_1.v2", "السكان", "emoji-😀-ok"]) {
      expect(isPublicDatasetId(good), good).toBe(true);
    }
  });

  it("the refresh body refuses a malformed id as a parse failure (a 400, before any rate-limit slot is used)", () => {
    expect(parseRefreshBody(body("seaports")).ok).toBe(true);
    for (const bad of ["a\u0000b", "a\ud800b", "a\nb", "x".repeat(201)]) {
      expect(parseRefreshBody(body(bad)).ok, JSON.stringify(bad)).toBe(false);
    }
    // the catalog shape is untouched by the id refine
    expect(parseRefreshBody('{"scope":"catalog"}')).toEqual({ ok: true, body: { scope: "catalog" } });
    expect(parseRefreshBody('{"scope":"catalog","id":"x"}').ok).toBe(false);
  });
});

describe("isAllowedOrigin", () => {
  const site = "https://data.example.bh";

  it("allows a missing Origin (curl, server-to-server)", () => {
    expect(isAllowedOrigin(null, "localhost:3000", site)).toBe(true);
  });

  it("allows the request host and the configured site host", () => {
    expect(isAllowedOrigin("http://localhost:3101", "localhost:3101", undefined)).toBe(true);
    expect(isAllowedOrigin("https://data.example.bh", "127.0.0.1:3000", site)).toBe(true);
    expect(isAllowedOrigin("HTTPS://DATA.EXAMPLE.BH", "127.0.0.1:3000", site)).toBe(true);
  });

  it("rejects foreign, null and unparseable origins", () => {
    expect(isAllowedOrigin("https://evil.example", "localhost:3000", site)).toBe(false);
    expect(isAllowedOrigin("null", "localhost:3000", site)).toBe(false);
    expect(isAllowedOrigin("garbage", "localhost:3000", site)).toBe(false);
    expect(isAllowedOrigin("", "localhost:3000", site)).toBe(false);
    // same hostname, different port is a different origin
    expect(isAllowedOrigin("http://localhost:9999", "localhost:3000", undefined)).toBe(false);
  });
});

describe("freshness helpers", () => {
  const now = Date.parse("2026-10-03T12:00:00Z");

  it("isStale: never synced is stale; compares against the threshold", () => {
    const h = 3_600_000;
    expect(isStale(null, now, 48 * h)).toBe(true);
    expect(isStale(new Date(now - 47 * h), now, 48 * h)).toBe(false);
    expect(isStale(new Date(now - 49 * h), now, 48 * h)).toBe(true);
  });

  it("cooldownUntil: future anchor+cooldown only", () => {
    expect(cooldownUntil(null, 120, now)).toBeNull();
    expect(cooldownUntil(new Date(now - 130_000), 120, now)).toBeNull();
    expect(cooldownUntil(new Date(now - 60_000), 120, now)).toBe(new Date(now + 60_000).toISOString());
  });
});

describe("readTextCapped", () => {
  const mk = (body: string, headers: Record<string, string> = {}) =>
    new Request("http://x/y", { method: "POST", body, headers });

  it("reads small bodies", async () => {
    expect(await readTextCapped(mk('{"a":1}'), 100)).toBe('{"a":1}');
  });

  it("returns null above the cap, without trusting content-length alone", async () => {
    expect(await readTextCapped(mk("x".repeat(500)), 100)).toBeNull();
    const req = mk("tiny", { "content-length": "999999" });
    expect(await readTextCapped(req, 100)).toBeNull();
  });

  it("returns an empty string when there is no body", async () => {
    expect(await readTextCapped(new Request("http://x/y", { method: "POST" }), 100)).toBe("");
  });
});
