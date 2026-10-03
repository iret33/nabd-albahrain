import { describe, expect, it } from "vitest";
import {
  FAILED_AND_STALE_NOTICE,
  FAILED_RUN_NOTICE,
  STALE_NOTICE,
  freshnessNotice,
  isDataStale,
} from "@/lib/freshness-notice";
import { hasArabic, textLang } from "@/lib/text";

const HOUR = 3_600_000;
const now = new Date("2026-10-03T12:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms);

describe("freshnessNotice", () => {
  const ok = { latestRunStatus: "success", lastSuccessAt: ago(HOUR), now, staleAfterMs: 48 * HOUR };

  it("says nothing when the last run succeeded recently", () => {
    expect(freshnessNotice(ok)).toBeNull();
  });

  it("treats a partial or still-running run as healthy", () => {
    expect(freshnessNotice({ ...ok, latestRunStatus: "partial" })).toBeNull();
    expect(freshnessNotice({ ...ok, latestRunStatus: "running" })).toBeNull();
    expect(freshnessNotice({ ...ok, latestRunStatus: null })).toBeNull();
  });

  it("flags a failed or aborted last run (aborted = crash/restart, same as failed)", () => {
    expect(freshnessNotice({ ...ok, latestRunStatus: "failed" })).toBe(FAILED_RUN_NOTICE);
    expect(freshnessNotice({ ...ok, latestRunStatus: "aborted" })).toBe(FAILED_RUN_NOTICE);
  });

  it("flags data older than the stale window, with the boundary exclusive", () => {
    expect(freshnessNotice({ ...ok, lastSuccessAt: ago(48 * HOUR) })).toBeNull();
    expect(freshnessNotice({ ...ok, lastSuccessAt: ago(48 * HOUR + 1) })).toBe(STALE_NOTICE);
  });

  it("combines failed and stale into one sentence", () => {
    expect(freshnessNotice({ ...ok, latestRunStatus: "failed", lastSuccessAt: ago(100 * HOUR) })).toBe(FAILED_AND_STALE_NOTICE);
  });

  it("does not call a never-synced portal stale (that is the empty state)", () => {
    expect(isDataStale(null, now, HOUR)).toBe(false);
    expect(freshnessNotice({ ...ok, lastSuccessAt: null, latestRunStatus: null })).toBeNull();
  });
});

describe("textLang / hasArabic", () => {
  it("marks Latin-only text as English", () => {
    expect(textLang("Live Births by Governorate")).toBe("en");
    expect(textLang("Population (2010-2025)")).toBe("en");
  });

  it("leaves Arabic and mixed Arabic+acronym text unlabeled", () => {
    expect(textLang("المواليد الأحياء")).toBeUndefined();
    expect(textLang("مؤشرات CPI الشهرية")).toBeUndefined();
  });

  it("does not label digits/punctuation-only text", () => {
    expect(textLang("2020")).toBeUndefined();
    expect(textLang("")).toBeUndefined();
    expect(textLang(null)).toBeUndefined();
    expect(hasArabic("abc")).toBe(false);
    expect(hasArabic("a ب")).toBe(true);
  });
});
