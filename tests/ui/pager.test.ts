import { describe, expect, it } from "vitest";
import { pageWindow } from "@/lib/pager";

describe("pageWindow", () => {
  it("shows every page when there are at most 7", () => {
    expect(pageWindow(1, 1)).toEqual([1]);
    expect(pageWindow(3, 5)).toEqual([1, 2, 3, 4, 5]);
    expect(pageWindow(4, 7)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("keeps a 7-slot window near the start", () => {
    expect(pageWindow(1, 20)).toEqual([1, 2, 3, 4, 5, "gap", 20]);
    expect(pageWindow(4, 20)).toEqual([1, 2, 3, 4, 5, "gap", 20]);
  });

  it("keeps a 7-slot window near the end", () => {
    expect(pageWindow(20, 20)).toEqual([1, "gap", 16, 17, 18, 19, 20]);
    expect(pageWindow(17, 20)).toEqual([1, "gap", 16, 17, 18, 19, 20]);
  });

  it("shows neighbours with a gap on each side in the middle", () => {
    expect(pageWindow(10, 20)).toEqual([1, "gap", 9, 10, 11, "gap", 20]);
    expect(pageWindow(5, 20)).toEqual([1, "gap", 4, 5, 6, "gap", 20]);
    expect(pageWindow(16, 20)).toEqual([1, "gap", 15, 16, 17, "gap", 20]);
  });

  it("is always 7 slots wide above 7 pages, so the pager never changes width", () => {
    for (let total = 8; total <= 40; total++) {
      for (let page = 1; page <= total; page++) expect(pageWindow(page, total)).toHaveLength(7);
    }
  });

  it("always includes the first, current and last page", () => {
    for (const [page, total] of [[1, 9], [5, 9], [9, 9], [2000, 2000], [1000, 2000]] as const) {
      const w = pageWindow(page, total);
      expect(w).toContain(1);
      expect(w).toContain(page);
      expect(w).toContain(total);
    }
  });

  it("clamps nonsense input instead of throwing", () => {
    expect(pageWindow(0, 20)).toEqual(pageWindow(1, 20));
    expect(pageWindow(999, 20)).toEqual(pageWindow(20, 20));
    expect(pageWindow(Number.NaN, 5)).toEqual([1, 2, 3, 4, 5]);
    expect(pageWindow(3, 0)).toEqual([1]);
    expect(pageWindow(3, Number.POSITIVE_INFINITY)).toEqual([1]);
  });
});
