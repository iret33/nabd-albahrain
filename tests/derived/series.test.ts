import { describe, expect, it } from "vitest";
import {
  detectPartialLastPeriod,
  fillPeriodGaps,
  findTotalSeries,
  inferAggregate,
  inferUnitFromLabel,
  isAdjacentPeriod,
  isLooseTotalLabel,
  isMeanLikeText,
  isStrictTotalLabel,
  median,
  parsePeriod,
  pickTotalSeriesKey,
  sumSeriesRow,
} from "@/lib/series";

describe("isStrictTotalLabel (whole label is just 'Total')", () => {
  it.each([
    ["Total", true],
    ["total", true],
    ["  TOTAL  ", true],
    ["Totals", true],
    ["Grand Total", true],
    ["grand total", true],
    ["Grand-Total", true],
    ["Total:", true],
    ["Overall", true],
    ["الإجمالي", true],
    ["إجمالي", true],
    ["الاجمالي", true],
    ["المجموع", true],
    ["مجموع", true],
    ["المجموع الكلي", true],
    ["الإجمالي العام", true],
    // legitimate parts / non-totals must never be dropped on a hidden dimension
    ["Total Imports", false],
    ["Total Male", false],
    ["Passengers Total", false],
    ["Subtotal", false],
    ["Sub-total", false],
    ["Totality", false],
    ["Bahraini", false],
    ["مجموعة", false],
    ["مجموعة أ", false],
    ["إجمالي الصادرات", false],
    ["", false],
  ])("%j -> %s", (label, expected) => {
    expect(isStrictTotalLabel(label)).toBe(expected);
  });
});

describe("isLooseTotalLabel (word-boundary total anywhere)", () => {
  it.each([
    ["Passengers Total", true],
    ["Total Imports", true],
    ["Total", true],
    ["passengers_total", true],
    ["Grand Total", true],
    ["Totals", true],
    ["Overall rate", true],
    ["إجمالي الركاب", true],
    ["مجموع الصادرات", true],
    ["المجموع", true],
    ["الإجمالي", true],
    // sub-totals, groups and look-alikes are not totals
    ["Subtotal", false],
    ["Sub-total", false],
    ["Sub total", false],
    ["Totalitarian", false],
    ["Mototal", false],
    ["المجموع الفرعي", false],
    ["مجموعة", false],
    ["مجموعات", false],
    ["مجموعة البيانات", false],
    ["Bahraini", false],
    ["Embark", false],
  ])("%j -> %s", (label, expected) => {
    expect(isLooseTotalLabel(label)).toBe(expected);
  });
});

describe("findTotalSeries", () => {
  it("airport case: 'Passengers Total' next to its components is THE total", () => {
    const values = ["Passengers Total", "Passengers Disembark", "Passengers Transfers", "Passengers Embark", "Passengers Transit"];
    expect(findTotalSeries(values)).toEqual({ key: "Passengers Total", matches: ["Passengers Total"], ambiguous: false });
    expect(pickTotalSeriesKey(values)).toBe("Passengers Total");
  });

  it("'Total Imports' + 'Total Exports' (+ Re-exports) is ambiguous, never 'first match wins'", () => {
    const r = findTotalSeries(["Total Imports", "Total Exports", "Re-exports"]);
    expect(r.key).toBeNull();
    expect(r.ambiguous).toBe(true);
    expect(r.matches).toEqual(["Total Imports", "Total Exports"]);
    expect(pickTotalSeriesKey(["Total Imports", "Total Exports", "Re-exports"])).toBeNull();
  });

  it("a unique strict 'Total' wins even when other values contain the word", () => {
    const r = findTotalSeries(["Total Imports", "Total Exports", "Total"]);
    expect(r).toMatchObject({ key: "Total", ambiguous: false });
  });

  it("two strict totals are ambiguous", () => {
    expect(findTotalSeries(["Total", "Grand Total", "A"]).ambiguous).toBe(true);
  });

  it("no total / a single value has nothing to be a total of", () => {
    expect(findTotalSeries(["Bahraini", "Non-Bahraini"])).toEqual({ key: null, matches: [], ambiguous: false });
    expect(findTotalSeries(["Total"])).toEqual({ key: null, matches: [], ambiguous: false });
    expect(findTotalSeries([])).toEqual({ key: null, matches: [], ambiguous: false });
  });
});

describe("sumSeriesRow", () => {
  const row = { period: "2024", a: 1, b: 2, c: null };
  it("sums what exists by default", () => {
    expect(sumSeriesRow(row, ["a", "b", "c"])).toBe(3);
  });
  it("requireAll: a missing series makes the whole row unusable instead of a fake drop", () => {
    expect(sumSeriesRow(row, ["a", "b", "c"], { requireAll: true })).toBeNull();
    expect(sumSeriesRow(row, ["a", "b"], { requireAll: true })).toBe(3);
  });
  it("null for undefined/empty series and ignores non-finite cells", () => {
    expect(sumSeriesRow(row, undefined)).toBeNull();
    expect(sumSeriesRow(row, [])).toBeNull();
    expect(sumSeriesRow({ a: Number.NaN, b: Infinity }, ["a", "b"])).toBeNull();
  });
});

describe("inferAggregate (token-aware, no substring false positives)", () => {
  // The reproduced false positives of the old unbounded /rate|percent|ratio|average|.../ regex.
  it.each([
    "Number of Registrations",
    "Registrations",
    "Operations",
    "Duration (days)",
    "Administration",
    "Declarations",
    "Migration",
    "Generation",
    "Corporate",
    "Separate",
    "Passengers",
    "Unemployed Persons",
    "Value",
    "Number of Cases",
    "Total Imports",
    "n_operations",
    "عدد المسجلين",
    "مجموعة",
  ])("count-like %j is summed", (label) => {
    expect(inferAggregate({ name: label, label })).toBe("sum");
  });

  // The reproduced false negatives: non-additive measures that used to be summed.
  it.each([
    "Index",
    "Price",
    "Prices",
    "Temperature",
    "Level",
    "Consumer Price Index",
    "Humidity",
    "Density",
    "Rate",
    "Unemployment Rate",
    "Birth rates",
    "Percent",
    "Percentage of women",
    "Ratio",
    "Average Price",
    "Mean wage",
    "Median income",
    "Population per capita",
    "Deaths per 1000",
    "Deaths per 100,000",
    "Point",
    "Unemployment (%)",
    "معدل البطالة",
    "نسبة المشاركة",
    "متوسط الأجر",
    "مؤشر الأسعار",
    "درجة الحرارة",
    "أسعار النفط",
  ])("non-additive %j is averaged", (label) => {
    expect(inferAggregate({ name: label, label })).toBe("mean");
  });

  it("splits camelCase and snake_case names", () => {
    expect(inferAggregate({ name: "passengerRate", label: "passengerRate" })).toBe("mean");
    expect(inferAggregate({ name: "unemploymentRate" })).toBe("mean");
    expect(inferAggregate({ name: "unemployment_rate" })).toBe("mean");
    expect(inferAggregate({ name: "price_index" })).toBe("mean");
    expect(inferAggregate({ name: "registrations_count" })).toBe("sum");
    expect(inferAggregate({ name: "operationsCount" })).toBe("sum");
  });

  it("a % in the label or unit means mean, even for an innocent name", () => {
    expect(inferAggregate({ name: "value", label: "Value (%)" })).toBe("mean");
    expect(inferAggregate({ name: "value", label: "Value", unit: "%" })).toBe("mean");
    expect(inferAggregate({ name: "value", label: "Value", unit: "BHD" })).toBe("sum");
  });

  it("checks name, label and unit; never returns 'last' (override-only)", () => {
    expect(inferAggregate({ name: "x", label: "Average speed" })).toBe("mean");
    expect(inferAggregate({ name: "avg_speed", label: "Speed" })).toBe("mean");
    for (const t of ["Stock", "Cumulative total", "Balance"]) expect(inferAggregate({ label: t })).not.toBe("last");
  });

  it("isMeanLikeText copes with empty input", () => {
    expect(isMeanLikeText(null)).toBe(false);
    expect(isMeanLikeText(undefined)).toBe(false);
    expect(isMeanLikeText("")).toBe(false);
  });
});

describe("inferUnitFromLabel", () => {
  it.each([
    ["Area (km2)", "km2"],
    ["Value (BHD)", "BHD"],
    ["Unemployment (%)", "%"],
    ["Imports [BD million]", "BD million"],
    ["Unemployment %", "%"],
    ["القيمة بالدينار البحريني", "بالدينار البحريني"],
    ["Area (km2) ", "km2"],
  ])("%j -> %j", (label, unit) => {
    expect(inferUnitFromLabel(label)).toBe(unit);
  });

  it.each(["Year (2020)", "Total (Total)", "Value", "", "Passengers (Arabic)", "Name (n)"])("no unit in %j", (label) => {
    expect(inferUnitFromLabel(label)).toBeNull();
  });
  it("null/undefined", () => {
    expect(inferUnitFromLabel(null)).toBeNull();
    expect(inferUnitFromLabel(undefined)).toBeNull();
  });
});

describe("periods", () => {
  it("parsePeriod accepts only the persisted shapes", () => {
    expect(parsePeriod("2026")).toEqual({ year: 2026, month: null });
    expect(parsePeriod("2026-03")).toEqual({ year: 2026, month: 3 });
    expect(parsePeriod("2026-13")).toBeNull();
    expect(parsePeriod("2026-3")).toBeNull();
    expect(parsePeriod("abc")).toBeNull();
  });

  it("fills the missing years so gaps are visible (2015, 2016, 2019)", () => {
    const { periods, step } = fillPeriodGaps(["2015", "2016", "2019"], "year");
    expect(periods).toEqual(["2015", "2016", "2017", "2018", "2019"]);
    expect(step).toBe(1);
  });

  it("fills missing months across a year boundary", () => {
    const { periods } = fillPeriodGaps(["2024-11", "2025-01", "2025-02", "2025-04"], "month");
    expect(periods).toEqual(["2024-11", "2024-12", "2025-01", "2025-02", "2025-03", "2025-04"]);
  });

  it("does NOT break a regular lower-frequency series into dots (quarterly, biennial, decennial)", () => {
    const q = fillPeriodGaps(["2020-01", "2020-04", "2020-07", "2020-10", "2021-01"], "month");
    expect(q.periods).toHaveLength(5);
    expect(q.step).toBe(3);
    const biennial = fillPeriodGaps(["2010", "2012", "2014", "2018"], "year");
    expect(biennial.periods).toEqual(["2010", "2012", "2014", "2016", "2018"]);
    expect(biennial.step).toBe(2);
    expect(fillPeriodGaps(["2010", "2020"], "year").periods).toEqual(["2010", "2020"]);
  });

  it("leaves 0/1 periods and unparseable periods alone", () => {
    expect(fillPeriodGaps([], "year").periods).toEqual([]);
    expect(fillPeriodGaps(["2020"], "year").periods).toEqual(["2020"]);
    expect(fillPeriodGaps(["2020", "x"], "year").periods).toEqual(["2020", "x"]);
  });

  it("isAdjacentPeriod respects the cadence step", () => {
    expect(isAdjacentPeriod("2024", "2025", "year")).toBe(true);
    expect(isAdjacentPeriod("2023", "2025", "year")).toBe(false);
    expect(isAdjacentPeriod("2024-12", "2025-01", "month")).toBe(true);
    expect(isAdjacentPeriod("2025-01", "2025-04", "month", 3)).toBe(true);
    expect(isAdjacentPeriod("2025-01", "2025-04", "month")).toBe(false);
  });
});

describe("detectPartialLastPeriod", () => {
  it("flags a half-filled last period (CPI-style: 12 rows per year, 6 in the current one)", () => {
    expect(detectPartialLastPeriod([12, 12, 12, 12, 12, 6])).toBe(true);
    expect(detectPartialLastPeriod([120, 120, 120, 60])).toBe(true);
  });
  it("does not flag a full or slightly short period (threshold is 75% of the median)", () => {
    expect(detectPartialLastPeriod([12, 12, 12, 12, 12, 12])).toBe(false);
    expect(detectPartialLastPeriod([12, 12, 12, 12, 12, 9])).toBe(false);
    expect(detectPartialLastPeriod([12, 12, 12, 12, 12, 8])).toBe(true); // 8 < 9
  });
  it("needs at least 3 PRIOR periods, not 3 in total", () => {
    expect(detectPartialLastPeriod([12, 12, 3])).toBe(false);
    expect(detectPartialLastPeriod([12, 12, 12, 3])).toBe(true);
    expect(detectPartialLastPeriod([])).toBe(false);
  });
  it("uses the median of at most the 5 previous periods", () => {
    expect(detectPartialLastPeriod([1, 1, 1, 100, 100, 100, 100, 100, 60])).toBe(true);
    expect(detectPartialLastPeriod([100, 100, 100, 1, 1, 1, 1, 1, 60])).toBe(false);
  });
  it("cannot judge one-row-per-period tables (documented limit)", () => {
    expect(detectPartialLastPeriod([1, 1, 1, 1, 1, 1])).toBe(false);
  });
  it("median helper", () => {
    expect(median([])).toBe(0);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
  });
});
