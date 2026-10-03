import { describe, expect, it } from "vitest";
import { axisNumberFormatter, valueAxisWidth } from "@/lib/chart-model";
import { formatCompact, formatCompactAr, formatPeriodLabelAr, formatPeriodTickAr, stripBidiMarks } from "@/lib/format";

const RLM = "‏";

describe("formatCompactAr (R5-14: Arabic units on value axes)", () => {
  it.each([
    [0, "0"],
    [999, "999"],
    [1000, "1 ألف"],
    [1500, "1.5 ألف"],
    [8000, "8 آلاف"],
    [11_000, "11 ألف"],
    [250_000, "250 ألف"],
    [1_200_000, "1.2 مليون"],
    [1_500_000_000, "1.5 مليار"],
    [60_000_000_000, "60 مليار"],
    [2_000_000_000_000, "2 ترليون"],
  ])("%d reads '%s' (Latin digits, no K/M/B)", (n, expected) => {
    const out = formatCompactAr(n);
    expect(stripBidiMarks(out)).toBe(expected);
    expect(out).not.toMatch(/[KMB]\b/);
    expect(out).not.toMatch(/[٠-٩]/);
  });

  it("starts a unit label with an RLM so it reads right to left inside a dir=ltr canvas", () => {
    expect(formatCompactAr(8000).startsWith(RLM)).toBe(true);
    // a plain number needs none
    expect(formatCompactAr(500)).toBe("500");
  });

  it("keeps a negative number's minus at the left of its digits, in an LTR isolate", () => {
    const out = formatCompactAr(-250_000);
    expect(out).toContain("⁦-250⁩");
    expect(stripBidiMarks(out)).toBe("-250 ألف");
  });

  it("is a dash for non-finite input", () => {
    expect(formatCompactAr(null)).toBe("—");
    expect(formatCompactAr(Number.NaN)).toBe("—");
    expect(formatCompactAr(Infinity)).toBe("—");
  });

  it("measures the axis from what is drawn, not from the invisible marks", () => {
    const withMarks = valueAxisWidth(formatCompactAr, 0, 8000);
    const drawn = valueAxisWidth((n) => stripBidiMarks(formatCompactAr(n)), 0, 8000);
    expect(drawn).toBeLessThan(withMarks);
    // and the Arabic label is wider than the Latin "8K" it replaced, so the axis grows with it
    expect(drawn).toBeGreaterThan(valueAxisWidth(formatCompact, 0, 8000));
    // axisNumberFormatter now IS the Arabic formatter from 1,000 up (one source of truth)
    expect(valueAxisWidth(axisNumberFormatter(8000), 0, 8000)).toBe(withMarks);
  });
});

describe("formatPeriodLabelAr / formatPeriodTickAr (R5-14: no ISO month ticks)", () => {
  it.each([
    ["2022-01", "يناير 2022"],
    ["2022-09", "سبتمبر 2022"],
    ["2026-12", "ديسمبر 2026"],
  ])("%s reads '%s'", (key, label) => {
    expect(formatPeriodLabelAr(key)).toBe(label);
  });

  it("leaves a year and every other key alone", () => {
    for (const key of ["2014", "2022-13", "2022-00", "2022-Q1", "Capital", "", "2022-09-15"]) {
      expect(formatPeriodLabelAr(key)).toBe(key);
      expect(formatPeriodTickAr(key)).toBe(key);
    }
    expect(formatPeriodLabelAr(undefined)).toBe("");
    expect(formatPeriodLabelAr(2014)).toBe("2014");
  });

  it("uses Latin digits for the year", () => {
    expect(formatPeriodLabelAr("2022-03")).toMatch(/2022/);
    expect(formatPeriodLabelAr("2022-03")).not.toMatch(/[٠-٩]/);
  });

  it("prefixes a month tick with an RLM so 'سبتمبر 2022' does not flip inside the LTR canvas", () => {
    expect(formatPeriodTickAr("2022-09")).toBe(`${RLM}سبتمبر 2022`);
    expect(formatPeriodTickAr("2014")).toBe("2014");
  });

  it("handles the earliest years", () => {
    expect(formatPeriodLabelAr("0099-02")).toMatch(/99/);
  });
});
