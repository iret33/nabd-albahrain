import { describe, expect, it } from "vitest";
import { NOUNS, countParts, countPhrase } from "@/lib/arabic-count";

describe("countPhrase", () => {
  it("agrees the noun with the count at every boundary", () => {
    expect(countPhrase(1, NOUNS.record)).toBe("سجل واحد");
    expect(countPhrase(2, NOUNS.record)).toBe("سجلان");
    expect(countPhrase(3, NOUNS.record)).toBe("3 سجلات");
    expect(countPhrase(10, NOUNS.record)).toBe("10 سجلات");
    expect(countPhrase(11, NOUNS.record)).toBe("11 سجلًا");
    expect(countPhrase(100, NOUNS.record)).toBe("100 سجلًا");
  });
  it("groups large numbers with Latin digits", () => {
    expect(countPhrase(100000, NOUNS.record)).toBe("100,000 سجلًا");
  });
  it("uses the oblique dual after a preposition", () => {
    expect(countPhrase(2, NOUNS.field, { oblique: true })).toBe("حقلين");
    expect(countPhrase(2, NOUNS.field)).toBe("حقلان");
    expect(countPhrase(2, NOUNS.category, { oblique: true })).toBe("فئتين");
  });
  it("agrees gender for the singular number word", () => {
    expect(countPhrase(1, NOUNS.category)).toBe("فئة واحدة");
    expect(countPhrase(1, NOUNS.field)).toBe("حقل واحد");
  });
  it("handles field and category plurals", () => {
    expect(countPhrase(3, NOUNS.field)).toBe("3 حقول");
    expect(countPhrase(4, NOUNS.category)).toBe("4 فئات");
    expect(countPhrase(12, NOUNS.category)).toBe("12 فئةً");
  });
  it("clamps nonsense input instead of throwing", () => {
    expect(countPhrase(Number.NaN, NOUNS.record)).toBe("0 سجلًا");
    expect(countPhrase(-5, NOUNS.record)).toBe("0 سجلًا");
  });
});

describe("countParts", () => {
  it("returns no digit string when the noun carries the count", () => {
    expect(countParts(1, NOUNS.record).number).toBeNull();
    expect(countParts(2, NOUNS.record).number).toBeNull();
    expect(countParts(7, NOUNS.record)).toEqual({ number: "7", noun: "سجلات" });
  });
});
