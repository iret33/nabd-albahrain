import { describe, expect, it, vi } from "vitest";
import {
  getAutoSyncIntervalMinutes,
  getOdsBaseUrl,
  getStaleAfterMs,
  loadPublicRefreshConfig,
  loadSyncConfig,
  parseIntEnv,
} from "@/lib/sync/config";

describe("parseIntEnv", () => {
  const opts = { def: 3, min: 1, max: 10 };

  it("uses the default for unset / empty", () => {
    expect(parseIntEnv({}, "X", opts)).toBe(3);
    expect(parseIntEnv({ X: "" }, "X", opts)).toBe(3);
    expect(parseIntEnv({ X: "   " }, "X", opts)).toBe(3);
  });

  it("parses plain integers inside the range", () => {
    expect(parseIntEnv({ X: "7" }, "X", opts)).toBe(7);
    expect(parseIntEnv({ X: " 5 " }, "X", opts)).toBe(5);
  });

  it("clamps out-of-range values instead of passing them on", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(parseIntEnv({ CLAMP_LOW: "-1" }, "CLAMP_LOW", opts)).toBe(1);
    expect(parseIntEnv({ CLAMP_ZERO: "0" }, "CLAMP_ZERO", opts)).toBe(1);
    expect(parseIntEnv({ CLAMP_HIGH: "999" }, "CLAMP_HIGH", opts)).toBe(10);
    warn.mockRestore();
  });

  it("falls back to the default on garbage", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const [i, bad] of ["abc", "1.5", "1e3", "NaN", "0x10", "--3"].entries()) {
      expect(parseIntEnv({ [`GARBAGE_${i}`]: bad }, `GARBAGE_${i}`, opts)).toBe(3);
    }
    warn.mockRestore();
  });
});

describe("loadSyncConfig", () => {
  it("has the documented defaults", () => {
    const c = loadSyncConfig({});
    expect(c.concurrency).toBe(3);
    expect(c.delayMs).toBe(250);
    expect(c.exportTimeoutMs).toBe(120_000);
    expect(c.retryBaseMs).toBe(1_000);
    expect(c.userAgent).toMatch(/^nabd-albahrain\//);
  });

  it("never lets SYNC_CONCURRENCY make the limiter queue forever", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(loadSyncConfig({ SYNC_CONCURRENCY: "-1" }).concurrency).toBe(1);
    expect(loadSyncConfig({ SYNC_CONCURRENCY: "0" }).concurrency).toBe(1);
    expect(loadSyncConfig({ SYNC_CONCURRENCY: "50" }).concurrency).toBe(10);
    warn.mockRestore();
  });

  it("honours overrides and a custom user agent", () => {
    const c = loadSyncConfig({ SYNC_DELAY_MS: "0", SYNC_EXPORT_TIMEOUT_MS: "5000", USER_AGENT: " my-agent/2 " });
    expect(c.delayMs).toBe(0);
    expect(c.exportTimeoutMs).toBe(5000);
    expect(c.userAgent).toBe("my-agent/2");
  });
});

describe("getOdsBaseUrl", () => {
  it("defaults to the public portal and strips trailing slashes", () => {
    expect(getOdsBaseUrl({})).toBe("https://data.gov.bh/api/explore/v2.1");
    expect(getOdsBaseUrl({ ODS_BASE_URL: "http://127.0.0.1:4010/api/explore/v2.1//" })).toBe(
      "http://127.0.0.1:4010/api/explore/v2.1",
    );
  });
});

describe("scheduler / freshness settings", () => {
  it("treats unset or 0 as off", () => {
    expect(getAutoSyncIntervalMinutes({})).toBe(0);
    expect(getAutoSyncIntervalMinutes({ AUTO_SYNC_INTERVAL_MINUTES: "0" })).toBe(0);
    expect(getAutoSyncIntervalMinutes({ AUTO_SYNC_INTERVAL_MINUTES: "360" })).toBe(360);
  });

  it("stale threshold is 2x the interval, or 48h with the scheduler off", () => {
    expect(getStaleAfterMs({ AUTO_SYNC_INTERVAL_MINUTES: "60" })).toBe(2 * 60 * 60_000);
    expect(getStaleAfterMs({})).toBe(48 * 3_600_000);
  });
});

describe("loadPublicRefreshConfig", () => {
  it("defaults", () => {
    expect(loadPublicRefreshConfig({})).toEqual({
      enabled: true,
      catalogCooldownSeconds: 120,
      datasetCooldownSeconds: 600,
      maxRecords: 100_000,
      maxDatasets: 5,
    });
  });

  it("only PUBLIC_REFRESH_ENABLED=0 disables it", () => {
    expect(loadPublicRefreshConfig({ PUBLIC_REFRESH_ENABLED: "0" }).enabled).toBe(false);
    expect(loadPublicRefreshConfig({ PUBLIC_REFRESH_ENABLED: "1" }).enabled).toBe(true);
    expect(loadPublicRefreshConfig({ PUBLIC_REFRESH_ENABLED: "" }).enabled).toBe(true);
  });

  it("reads cooldowns and the row cap", () => {
    const c = loadPublicRefreshConfig({
      PUBLIC_REFRESH_CATALOG_COOLDOWN_SECONDS: "30",
      PUBLIC_REFRESH_DATASET_COOLDOWN_SECONDS: "90",
      PUBLIC_REFRESH_MAX_RECORDS: "5000",
    });
    expect(c.catalogCooldownSeconds).toBe(30);
    expect(c.datasetCooldownSeconds).toBe(90);
    expect(c.maxRecords).toBe(5000);
  });
});
