import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { render, textOf } from "./render";
import { DatasetCard, type DatasetCardData } from "@/components/dataset-card";
import { CountNoun } from "@/components/count-noun";
import { NOUNS } from "@/lib/arabic-count";

function card(over: Partial<DatasetCardData> = {}): DatasetCardData {
  return {
    id: "air-quality",
    title: "Air Quality",
    titleClean: "Air Quality",
    titleAr: null,
    theme: "Environment",
    publisher: "Supreme Council for Environment",
    recordsCount: 12,
    sourceCount: 12,
    sourceModified: new Date("2026-01-15T08:00:00Z"),
    lastSyncedAt: new Date("2026-01-16T08:00:00Z"),
    syncStatus: "ok",
    chartData: null,
    vizConfig: null,
    ...over,
  } as DatasetCardData;
}

const footer = (over: Partial<DatasetCardData>) => textOf(render(createElement(DatasetCard, { dataset: card(over) })));

describe("DatasetCard record count (R5-04)", () => {
  it.each([
    [1, "سجل واحد"],
    [2, "سجلان"],
    [3, "3 سجلات"],
    [6, "6 سجلات"],
    [10, "10 سجلات"],
    [11, "11 سجلًا"],
    [1200, "1,200 سجلًا"],
  ])("%i records reads '%s'", (n, expected) => {
    const text = footer({ recordsCount: n, sourceCount: n });
    expect(text).toContain(expected);
    // never the old ungrammatical '<n> سجل'
    expect(text).not.toMatch(/\d سجل(?!\S)/);
  });

  it("says an empty dataset has no records instead of '0 سجل'", () => {
    const text = footer({ recordsCount: 0, sourceCount: 0 });
    expect(text).toContain("لا توجد سجلات");
    expect(text).not.toMatch(/\b0\b/);
  });

  it("agrees a partial dataset's noun with the total after 'من'", () => {
    expect(footer({ syncStatus: "partial", recordsCount: 12_345_678, sourceCount: 50_000 })).toContain("50,000 من 12,345,678 سجلًا");
    expect(footer({ syncStatus: "partial", recordsCount: 8, sourceCount: 5 })).toContain("5 من 8 سجلات");
    expect(footer({ syncStatus: "partial", recordsCount: 2, sourceCount: 1 })).toContain("1 من سجلين");
  });
});

describe("CountNoun", () => {
  const text = (n: number, oblique = false) => textOf(render(createElement(CountNoun, { n, forms: NOUNS.record, oblique })));

  it("prints digits only when the noun does not carry the count", () => {
    expect(text(1)).toBe("سجل واحد");
    expect(text(2)).toBe("سجلان");
    expect(text(2, true)).toBe("سجلين");
    expect(text(7)).toBe("7 سجلات");
    expect(text(250)).toBe("250 سجلًا");
  });

  it("wraps the digits in an LTR tabular span", () => {
    expect(render(createElement(CountNoun, { n: 1200, forms: NOUNS.record }))).toContain('<span dir="ltr" class="tabular-figures inline-block ">1,200</span>');
  });
});
