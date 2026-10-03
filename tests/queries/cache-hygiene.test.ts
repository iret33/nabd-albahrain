import { describe, expect, it } from "vitest";
import {
  DEFAULT_CACHE_TTL_SECONDS,
  MAX_CACHE_TTL_SECONDS,
  MAX_DATASET_ID_LENGTH,
  MIN_CACHE_TTL_SECONDS,
  datasetTag,
  isValidDatasetId,
  isValidPublisherSlug,
  resolveCacheTtl,
} from "@/lib/cache-config";
import { clampPage, offsetFor, totalPagesFor } from "@/lib/page-math";

describe("resolveCacheTtl", () => {
  it("defaults when unset or blank", () => {
    expect(resolveCacheTtl(undefined)).toBe(DEFAULT_CACHE_TTL_SECONDS);
    expect(resolveCacheTtl("")).toBe(DEFAULT_CACHE_TTL_SECONDS);
    expect(resolveCacheTtl("   ")).toBe(DEFAULT_CACHE_TTL_SECONDS);
  });

  it("accepts plain integers in range", () => {
    expect(resolveCacheTtl("60")).toBe(60);
    expect(resolveCacheTtl(" 900 ")).toBe(900);
  });

  it("rejects non-integers and reports them", () => {
    const messages: string[] = [];
    for (const bad of ["abc", "1e3", "-5", "0x10", "1.5", "NaN", "Infinity"]) {
      expect(resolveCacheTtl(bad, (m) => messages.push(m))).toBe(DEFAULT_CACHE_TTL_SECONDS);
    }
    expect(messages).toHaveLength(7);
  });

  it("clamps out-of-range values and reports them", () => {
    const messages: string[] = [];
    expect(resolveCacheTtl("0", (m) => messages.push(m))).toBe(MIN_CACHE_TTL_SECONDS);
    expect(resolveCacheTtl("1", (m) => messages.push(m))).toBe(MIN_CACHE_TTL_SECONDS);
    expect(resolveCacheTtl("99999999", (m) => messages.push(m))).toBe(DEFAULT_CACHE_TTL_SECONDS); // > 7 digits: not a sane value
    expect(resolveCacheTtl("9999999", (m) => messages.push(m))).toBe(MAX_CACHE_TTL_SECONDS);
    expect(messages).toHaveLength(4);
  });
});

describe("tags", () => {
  it("builds per-dataset tags", () => {
    expect(datasetTag("abc")).toBe("dataset:abc");
  });
});

describe("isValidDatasetId", () => {
  it("accepts real-looking ids", () => {
    expect(isValidDatasetId("01-air-quality-in-kingdom-of-bahrain")).toBe(true);
    expect(isValidDatasetId("population_by.nationality")).toBe(true);
  });

  it("rejects empty, oversized, control-character and non-string ids", () => {
    expect(isValidDatasetId("")).toBe(false);
    expect(isValidDatasetId("x".repeat(MAX_DATASET_ID_LENGTH + 1))).toBe(false);
    expect(isValidDatasetId("x".repeat(MAX_DATASET_ID_LENGTH))).toBe(true);
    expect(isValidDatasetId("a\u0000b")).toBe(false);
    expect(isValidDatasetId("a\nb")).toBe(false);
    expect(isValidDatasetId(undefined)).toBe(false);
    expect(isValidDatasetId(["a"])).toBe(false);
    expect(isValidDatasetId(42)).toBe(false);
  });
});

describe("isValidPublisherSlug", () => {
  it("accepts slugify() output and rejects everything else", () => {
    expect(isValidPublisherSlug("ministry-of-health")).toBe(true);
    expect(isValidPublisherSlug("")).toBe(false);
    expect(isValidPublisherSlug("Ministry Of Health")).toBe(false);
    expect(isValidPublisherSlug("a/b")).toBe(false);
    expect(isValidPublisherSlug("x".repeat(201))).toBe(false);
  });
});

describe("pagination arithmetic", () => {
  it("totalPagesFor is at least 1 and handles junk", () => {
    expect(totalPagesFor(0, 30)).toBe(1);
    expect(totalPagesFor(30, 30)).toBe(1);
    expect(totalPagesFor(31, 30)).toBe(2);
    expect(totalPagesFor(Number.NaN, 30)).toBe(1);
    expect(totalPagesFor(10, 0)).toBe(1);
    expect(totalPagesFor(-5, 30)).toBe(1);
  });

  it("clampPage maps every hostile value into [1, totalPages]", () => {
    expect(clampPage(5, 10)).toBe(5);
    expect(clampPage(999, 10)).toBe(10);
    expect(clampPage(0, 10)).toBe(1);
    expect(clampPage(-1, 10)).toBe(1);
    expect(clampPage(1.9, 10)).toBe(1);
    expect(clampPage(Number.NaN, 10)).toBe(1);
    expect(clampPage(Infinity, 10)).toBe(1);
    expect(clampPage(-Infinity, 10)).toBe(1);
    expect(clampPage(1e21, 10)).toBe(1);
    expect(clampPage(3, 0)).toBe(1);
    expect(clampPage("7" as unknown as number, 10)).toBe(1);
  });

  it("offsetFor is zero-based", () => {
    expect(offsetFor(1, 25)).toBe(0);
    expect(offsetFor(3, 25)).toBe(50);
  });
});
