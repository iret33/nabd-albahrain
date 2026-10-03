import { describe, expect, it } from "vitest";
import {
  BIG_DATASET_ROWS,
  SHRINK_GUARD_MIN_ROWS,
  assertExportIntegrity,
  assertPlausibleCatalog,
  isBigDataset,
} from "@/lib/sync/integrity";
import { SyncIntegrityError } from "@/lib/sync/errors";
import type { CatalogDataset } from "@/lib/sync/schemas";

const stored = (syncStatus: string, sourceCount: number) => ({ syncStatus, sourceCount });

describe("assertExportIntegrity: truncated exports (r1-11)", () => {
  it("an empty export is refused when the catalog says there is data, and fine when it does not", () => {
    expect(() => assertExportIntegrity(0, 13, stored("ok", 12), false)).toThrow(SyncIntegrityError);
    expect(() => assertExportIntegrity(0, 0, stored("ok", 0), false)).not.toThrow();
    expect(() => assertExportIntegrity(0, 0, undefined, false)).not.toThrow();
  });

  it("protects SMALL datasets too: 14 rows of a 48-row dataset that held 44 is refused", () => {
    expect(() => assertExportIntegrity(14, 48, stored("ok", 44), false)).toThrow(
      "Export returned 14 rows but the catalog reports 48 (previously stored 44); keeping previous data unless forced",
    );
  });

  it("still refuses on the NEXT plain run: a dataset left in 'error' keeps its protection", () => {
    expect(() => assertExportIntegrity(14, 48, stored("error", 44), false)).toThrow(SyncIntegrityError);
    expect(() => assertExportIntegrity(90, 301, stored("error", 300), false)).toThrow(SyncIntegrityError);
  });

  it("is inert for a never-synced row (sourceCount 0), for partial rows (capped count) and when forced", () => {
    expect(() => assertExportIntegrity(14, 48, stored("pending", 0), false)).not.toThrow();
    expect(() => assertExportIntegrity(14, 48, undefined, false)).not.toThrow();
    expect(() => assertExportIntegrity(10, 300_000, stored("partial", 50_000), false)).not.toThrow();
    expect(() => assertExportIntegrity(14, 48, stored("ok", 44), true)).not.toThrow();
  });

  it("accepts a genuine shrink, where the portal's own count dropped with the rows", () => {
    expect(() => assertExportIntegrity(100, 100, stored("ok", 300), false)).not.toThrow();
    expect(() => assertExportIntegrity(14, 14, stored("ok", 44), false)).not.toThrow();
    // ...and a catalog count that has only dropped part of the way is judged against the fresh count
    expect(() => assertExportIntegrity(30, 60, stored("ok", 300), false)).not.toThrow();
  });

  it("does not flag half-full as truncated, only fewer than half of BOTH counts", () => {
    expect(() => assertExportIntegrity(22, 48, stored("ok", 44), false)).not.toThrow(); // 22 is not < 22
    expect(() => assertExportIntegrity(21, 48, stored("ok", 44), false)).toThrow();
  });

  it(`ignores datasets the portal itself says are tiny (< ${SHRINK_GUARD_MIN_ROWS} rows): half of 4 is noise`, () => {
    expect(() => assertExportIntegrity(1, 4, stored("ok", 4), false)).not.toThrow();
    expect(() => assertExportIntegrity(2, SHRINK_GUARD_MIN_ROWS - 1, stored("ok", 9), false)).not.toThrow();
    expect(() => assertExportIntegrity(2, SHRINK_GUARD_MIN_ROWS, stored("ok", 10), false)).toThrow();
  });
});

describe("assertPlausibleCatalog", () => {
  it("refuses a complete catalog under half the known live datasets, and accepts the rest", () => {
    expect(() => assertPlausibleCatalog(0, 10)).toThrow(/refusing to prune/);
    expect(() => assertPlausibleCatalog(4, 10)).toThrow(/refusing to prune/);
    expect(() => assertPlausibleCatalog(5, 10)).not.toThrow();
    expect(() => assertPlausibleCatalog(9, 10)).not.toThrow();
    expect(() => assertPlausibleCatalog(0, 0)).not.toThrow(); // nothing known: nothing to prune
  });
});

describe("isBigDataset", () => {
  const entry = (records_count: unknown): CatalogDataset =>
    ({ dataset_id: "x", metas: { default: { records_count } } }) as unknown as CatalogDataset;

  it(`is true above ${BIG_DATASET_ROWS} rows, false at or below`, () => {
    expect(isBigDataset(entry(BIG_DATASET_ROWS + 1))).toBe(true);
    expect(isBigDataset(entry(BIG_DATASET_ROWS))).toBe(false);
    expect(isBigDataset(entry(0))).toBe(false);
    expect(isBigDataset(entry(310_000))).toBe(true);
  });

  it("treats an unknown or invalid count conservatively (as big)", () => {
    expect(isBigDataset(entry(undefined))).toBe(true);
    expect(isBigDataset(entry("n/a"))).toBe(true);
    expect(isBigDataset(entry(-1))).toBe(true);
    expect(isBigDataset(entry(Number.NaN))).toBe(true);
    expect(isBigDataset({ dataset_id: "x" } as unknown as CatalogDataset)).toBe(true);
  });
});
