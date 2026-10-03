import { describe, expect, it } from "vitest";
import { groupByMonth, monthKey, monthLabelAr } from "@/lib/months";

describe("monthKey / monthLabelAr", () => {
  it("uses the Bahrain calendar month, not UTC", () => {
    // 2026-08-31 22:30 UTC is 01:30 on 1 September in Bahrain (UTC+3).
    expect(monthKey(new Date("2026-08-31T22:30:00Z"))).toBe("2026-09");
    expect(monthKey(new Date("2026-08-31T20:59:00Z"))).toBe("2026-08");
  });

  it("accepts ISO strings (cached rows revive as strings) and rejects junk", () => {
    expect(monthKey("2026-01-15T08:00:00+00:00")).toBe("2026-01");
    expect(monthKey("not a date")).toBeNull();
    expect(monthKey(null)).toBeNull();
    expect(monthKey(undefined)).toBeNull();
  });

  it("labels months in Arabic with Latin digits", () => {
    const label = monthLabelAr(new Date("2026-09-10T00:00:00Z"));
    expect(label).toContain("سبتمبر");
    expect(label).toContain("2026");
    expect(label).not.toMatch(/[٠-٩]/);
    expect(monthLabelAr(null)).toBe("—");
  });
});

describe("groupByMonth", () => {
  const item = (id: string, date: string | null) => ({ id, date });

  it("groups consecutive items by month and keeps their order", () => {
    const groups = groupByMonth(
      [item("a", "2026-09-20T10:00:00Z"), item("b", "2026-09-02T10:00:00Z"), item("c", "2026-08-30T10:00:00Z"), item("d", "2025-12-31T10:00:00Z")],
      (x) => x.date,
    );
    expect(groups.map((g) => g.key)).toEqual(["2026-09", "2026-08", "2025-12"]);
    expect(groups[0].items.map((x) => x.id)).toEqual(["a", "b"]);
    expect(groups[1].items.map((x) => x.id)).toEqual(["c"]);
    expect(groups[0].label).toContain("سبتمبر");
  });

  it("puts undated items in one trailing group", () => {
    const groups = groupByMonth([item("a", null), item("b", "2026-01-05T00:00:00Z"), item("c", "garbage")], (x) => x.date);
    expect(groups.map((g) => g.key)).toEqual(["2026-01", "undated"]);
    expect(groups[1].items.map((x) => x.id)).toEqual(["a", "c"]);
  });

  it("returns no groups for no items", () => {
    expect(groupByMonth([], () => null)).toEqual([]);
  });
});
