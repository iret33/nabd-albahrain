import { describe, expect, it } from "vitest";
import { assertProductionEnv, validateProductionEnv, weakSecretReason, type EnvLike } from "@/lib/env";

const ADMIN = "9f2c1ab07d3e4568b1c0a7e2d4f65b83a1c9e07d2b4f6a8c0e1d3b5a7c9e2f40";
const SYNC = "0be7a4d1c6f28359e0b4a7d2c1f68e35b9a0d4c7e2f1a6b8d3c5e9f07a2b4c61";

const good = (over: EnvLike = {}): EnvLike => ({
  NODE_ENV: "production",
  ADMIN_TOKEN: ADMIN,
  SYNC_TOKEN: SYNC,
  DATABASE_URL: "postgresql://nabd:s3cret@db:5432/nabd",
  ...over,
});

describe("weakSecretReason", () => {
  it("accepts openssl-style secrets", () => {
    expect(weakSecretReason(ADMIN)).toBeNull();
    expect(weakSecretReason("Zk3-pQ9_vLm2XrT8uYw5NbC7HdJ4sFgA1eO6iKaV")).toBeNull();
  });

  it.each([
    ["unset", undefined],
    ["empty", ""],
    ["short", "abc123"],
    ["31 chars", "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d"],
    ["change-me placeholder", "change-me-long-random-change-me-long-random"],
    ["changeme", "ChangeMe0123456789abcdef0123456789abcdef"],
    ["dev- prefix", "dev-admin-token-0123456789abcdef0123456789abcdef"],
    ["contains password", "xx-my-super-password-xx-0123456789abcdef0123"],
    ["repeated char", "a".repeat(64)],
    ["two symbols", "ab".repeat(32)],
  ])("rejects %s", (_name, value) => {
    expect(weakSecretReason(value)).not.toBeNull();
  });
});

describe("validateProductionEnv", () => {
  it("is a no-op outside production, however bad the env", () => {
    expect(validateProductionEnv({ NODE_ENV: "development", ADMIN_TOKEN: "x" })).toEqual([]);
    expect(validateProductionEnv({ NODE_ENV: "test" })).toEqual([]);
    expect(validateProductionEnv({})).toEqual([]);
    expect(() => assertProductionEnv({ NODE_ENV: "development" })).not.toThrow();
  });

  it("accepts a correct production env, with or without optional tunables", () => {
    expect(validateProductionEnv(good())).toEqual([]);
    expect(
      validateProductionEnv(
        good({
          SYNC_CONCURRENCY: "3",
          AUTO_SYNC_INTERVAL_MINUTES: "360",
          CACHE_TTL_SECONDS: "300",
          PUBLIC_REFRESH_ENABLED: "1",
          PUBLIC_REFRESH_CATALOG_COOLDOWN_SECONDS: "120",
          PUBLIC_REFRESH_DATASET_COOLDOWN_SECONDS: "600",
          PUBLIC_REFRESH_MAX_RECORDS: "100000",
          SESSION_SECRET: "Zk3-pQ9_vLm2XrT8uYw5NbC7HdJ4sFgA1eO6iKaV",
        }),
      ),
    ).toEqual([]);
    // Blank optional values behave like unset (compose/.env often leave `FOO=`).
    expect(validateProductionEnv(good({ SYNC_CONCURRENCY: "", AUTO_SYNC_INTERVAL_MINUTES: "  " }))).toEqual([]);
  });

  it("flags missing/placeholder secrets by variable name", () => {
    const problems = validateProductionEnv(
      good({ ADMIN_TOKEN: undefined, SYNC_TOKEN: "change-me-long-random-change-me-long-random" }),
    );
    expect(problems.some((p) => p.startsWith("ADMIN_TOKEN is not set"))).toBe(true);
    expect(problems.some((p) => p.startsWith("SYNC_TOKEN looks like a placeholder"))).toBe(true);
  });

  it("requires ADMIN_TOKEN and SYNC_TOKEN to differ", () => {
    const problems = validateProductionEnv(good({ SYNC_TOKEN: ADMIN }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/must be different/);
  });

  it("requires a postgres DATABASE_URL", () => {
    expect(validateProductionEnv(good({ DATABASE_URL: undefined }))).toEqual(["DATABASE_URL is not set"]);
    expect(validateProductionEnv(good({ DATABASE_URL: "" }))).toEqual(["DATABASE_URL is not set"]);
    expect(validateProductionEnv(good({ DATABASE_URL: "mysql://x" }))[0]).toMatch(/postgres/);
  });

  it.each(["0", "-1", "11", "1.5", "abc", "NaN", "Infinity"])("rejects SYNC_CONCURRENCY=%s", (value) => {
    const problems = validateProductionEnv(good({ SYNC_CONCURRENCY: value }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^SYNC_CONCURRENCY/);
  });

  it.each(["1", "5", "10"])("accepts SYNC_CONCURRENCY=%s", (value) => {
    expect(validateProductionEnv(good({ SYNC_CONCURRENCY: value }))).toEqual([]);
  });

  it.each([
    "AUTO_SYNC_INTERVAL_MINUTES",
    "CACHE_TTL_SECONDS",
    "PUBLIC_REFRESH_ENABLED",
    "PUBLIC_REFRESH_CATALOG_COOLDOWN_SECONDS",
    "PUBLIC_REFRESH_DATASET_COOLDOWN_SECONDS",
    "PUBLIC_REFRESH_MAX_RECORDS",
  ])("rejects non-numeric / negative %s", (name) => {
    for (const bad of ["abc", "-5", "Infinity", "12x"]) {
      const problems = validateProductionEnv(good({ [name]: bad }));
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatch(new RegExp(`^${name} must be a number`));
    }
    expect(validateProductionEnv(good({ [name]: "0" }))).toEqual([]);
  });

  it("holds an optional SESSION_SECRET to the same standard", () => {
    const problems = validateProductionEnv(good({ SESSION_SECRET: "short" }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^SESSION_SECRET/);
  });
});

describe("assertProductionEnv", () => {
  it("throws one aggregated error listing every problem and never the secret values", () => {
    const env = good({
      ADMIN_TOKEN: "hunter2-but-way-too-short",
      SYNC_TOKEN: "hunter2-but-way-too-short",
      DATABASE_URL: undefined,
      SYNC_CONCURRENCY: "-1",
      CACHE_TTL_SECONDS: "soon",
    });
    let message = "";
    try {
      assertProductionEnv(env);
    } catch (err) {
      message = (err as Error).message;
    }
    // short ADMIN, short SYNC, identical tokens, DATABASE_URL, SYNC_CONCURRENCY, CACHE_TTL_SECONDS
    expect(validateProductionEnv(env)).toHaveLength(6);
    expect(message).toContain("6 problems");
    for (const needle of ["ADMIN_TOKEN", "SYNC_TOKEN", "DATABASE_URL", "SYNC_CONCURRENCY", "CACHE_TTL_SECONDS"]) {
      expect(message).toContain(needle);
    }
    expect(message).not.toContain("hunter2");
  });

  it("does not throw for a valid production env", () => {
    expect(() => assertProductionEnv(good())).not.toThrow();
  });
});
