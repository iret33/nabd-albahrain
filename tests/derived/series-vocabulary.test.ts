import { describe, expect, it } from "vitest";
import {
  detectPartialLastPeriodByCalendar,
  findNumericTotalSeries,
  inferAggregate,
  isIdentifierLikeName,
  isIndicatorDimensionName,
  isLastPeriodPartial,
  isNonAdditiveSeriesName,
  isTotalCandidateLabel,
  totalCellsAgree,
  type PeriodCoverage,
} from "@/lib/series";

/** Group F3 unit tests for series.ts additions: r3-10 vocabulary, r3-08 calendar, r3-02 numeric totals, r3-04 / r3-01 name predicates. */

describe("r3-10: aggregate inference vocabulary (conservative additions)", () => {
  // ratios, densities, speeds and growth figures that were SUMMED (12 monthly 'students per teacher' made 168)
  it.each([
    "Students per teacher",
    "Pupils per class",
    "Population per km2",
    "Visitors per flight",
    "عدد السكان لكل كم2",
    "عدد الطلاب لكل معلم",
    "Wind speed (km/h)",
    "Concentration (µg/m3)",
    "Life expectancy",
    "Share of exports",
    "Score",
    "Rank",
    "Growth (y/y)",
    "Inflation",
    "Load factor",
    "Utilization",
    "Utilisation rate",
    "Yield",
  ])("%j is a mean", (label) => {
    expect(inferAggregate({ name: label, label })).toBe("mean");
  });

  it("a slash inside a UNIT is a ratio; a slash elsewhere in the label is just a list", () => {
    expect(inferAggregate({ name: "v", label: "Speed", unit: "km/h" })).toBe("mean");
    expect(inferAggregate({ name: "v", label: "Price (BHD/kg)" })).toBe("mean");
    expect(inferAggregate({ name: "v", label: "Imports/Exports (BHD)" })).toBe("sum");
    expect(inferAggregate({ name: "v", label: "Male/Female (persons)" })).toBe("sum");
  });

  // counts that merely contain a ratio-ish word or a time unit after "per"
  it.each([
    "Number of visits per year",
    "Cases per quarter",
    "Passengers per month",
    "Tonnes per day",
    "Number of Level 3 schools",
    "Number of price changes",
    "عدد المدارس المتوسطة",
    "عدد المستويات التعليمية",
    "عدد الأسعار",
    "Cargo load (tonnes)",
    "Shares traded",
  ])("count %j stays summed", (label) => {
    expect(inferAggregate({ name: label, label })).toBe("sum");
  });

  it("existing spec behaviours are untouched ('متوسط الأجر', 'المتوسط', 'Level', 'Prices')", () => {
    for (const label of ["متوسط الأجر", "المتوسط", "الأسعار", "مستوى البحر", "Level", "Prices", "معدل البطالة"]) {
      expect(inferAggregate({ name: label, label }), label).toBe("mean");
    }
  });

  it("an intermediate-school COUNT is a sum even without the 'عدد' prefix when the label names schools", () => {
    expect(inferAggregate({ name: "x", label: "المدارس المتوسطة" })).toBe("sum");
    expect(inferAggregate({ name: "x", label: "متوسط عدد الطلاب في المدارس" })).toBe("mean");
  });
});

describe("r3-08: calendar completeness (unit)", () => {
  const cov = (spec: Array<[string, number, number?]>): PeriodCoverage[] => spec.map(([period, count, maxDay]) => ({ period, count, maxDay }));
  const dailyHistory: Array<[string, number, number?]> = [
    ["2025-03", 31, 31],
    ["2025-04", 30, 30],
    ["2025-05", 31, 31],
    ["2025-06", 30, 30],
    ["2025-07", 31, 31],
    ["2025-08", 31, 31],
  ];

  it.each([
    [24, true],
    [28, true],
    [29, true],
    [30, false],
  ])("daily history, September cut at day %i -> partial %s", (day, expected) => {
    expect(detectPartialLastPeriodByCalendar(cov([...dailyHistory, ["2025-09", day, day]]))).toBe(expected);
  });

  it("needs two dated prior periods and ignores day-less periods", () => {
    expect(detectPartialLastPeriodByCalendar(cov([["2025-08", 31, 31], ["2025-09", 10, 10]]))).toBe(false);
    expect(detectPartialLastPeriodByCalendar(cov([["2025-07", 31, 31], ["2025-08", 31, 31], ["2025-09", 10, 10]]))).toBe(true);
    expect(detectPartialLastPeriodByCalendar(cov([["2025-07", 31], ["2025-08", 31], ["2025-09", 10]]))).toBe(false);
  });

  it("a cadence whose complete months end up to a week before month end is learned, not flagged", () => {
    // weekly data: complete months end 0-6 days before month end
    const weekly: Array<[string, number, number?]> = [["2025-05", 4, 26], ["2025-06", 4, 30], ["2025-07", 5, 28], ["2025-08", 4, 25]];
    expect(detectPartialLastPeriodByCalendar(cov([...weekly, ["2025-09", 4, 29]]))).toBe(false);
    expect(detectPartialLastPeriodByCalendar(cov([...weekly, ["2025-09", 2, 15]]))).toBe(true);
  });

  it("the calendar alone cannot hide a period that has about as many rows as usual", () => {
    expect(detectPartialLastPeriodByCalendar(cov([...dailyHistory, ["2025-09", 31, 27]]))).toBe(false);
  });

  it("an irregular cadence (largest prior slack above a week) is not judged", () => {
    const sparse: Array<[string, number, number?]> = [["2025-06", 5, 10], ["2025-07", 5, 22], ["2025-08", 5, 12]];
    expect(detectPartialLastPeriodByCalendar(cov([...sparse, ["2025-09", 1, 3]]))).toBe(false);
  });

  it("isLastPeriodPartial is the count rule OR the calendar rule", () => {
    expect(isLastPeriodPartial(cov([["2024", 12], ["2025", 12], ["2026", 12], ["2027", 4]]))).toBe(true);
    expect(isLastPeriodPartial(cov([...dailyHistory, ["2025-09", 26, 26]]))).toBe(true);
    expect(isLastPeriodPartial(cov([...dailyHistory, ["2025-09", 30, 30]]))).toBe(false);
  });
});

describe("r3-02: numeric total detection (unit)", () => {
  const rows = (cells: Array<Record<string, number | null>>) => cells.map((c, i) => ({ period: String(2020 + i), ...c }));

  it("finds the series that equals the sum of the others, whatever it is called", () => {
    const r = rows([
      { Capital: 10, Muharraq: 20, Northern: 30, Kingdom: 60 },
      { Capital: 11, Muharraq: 20, Northern: 31, Kingdom: 62 },
      { Capital: 12, Muharraq: 21, Northern: 32, Kingdom: 65 },
    ]);
    expect(findNumericTotalSeries(r, ["Capital", "Muharraq", "Northern", "Kingdom"])).toBe("Kingdom");
  });

  it("tolerates rounding drift (0.5% relative, or half a unit per integer part)", () => {
    const r = rows([
      { a: 10, b: 20, c: 31 }, // 61 vs 60.. integers: allowed drift 1.0 for two parts? 31 vs 30 -> within 0.5*2
      { a: 11, b: 20, c: 31 },
      { a: 12, b: 21, c: 33 },
    ]);
    expect(findNumericTotalSeries(r, ["a", "b", "c"])).toBe("c");
  });

  it.each([
    ["only two series (equal legitimate parts)", [{ a: 5, b: 5 }, { a: 6, b: 6 }, { a: 7, b: 7 }], ["a", "b"]],
    ["fewer than three comparable periods", [{ a: 1, b: 2, c: 3 }, { a: 1, b: 2, c: 3 }], ["a", "b", "c"]],
    ["negative values", [{ a: -1, b: 2, c: 1 }, { a: -1, b: 2, c: 1 }, { a: -1, b: 2, c: 1 }], ["a", "b", "c"]],
    ["no series adds up", [{ a: 1, b: 5, c: 9 }, { a: 2, b: 6, c: 9 }, { a: 3, b: 7, c: 9 }], ["a", "b", "c"]],
  ])("null: %s", (_name, cells, keys) => {
    expect(findNumericTotalSeries(rows(cells as Array<Record<string, number>>), keys as string[])).toBeNull();
  });

  it("ambiguous (two series both equal the sum of the rest, e.g. a zero part) is null", () => {
    const r = rows([
      { a: 0, b: 5, c: 5 },
      { a: 0, b: 6, c: 6 },
      { a: 0, b: 7, c: 7 },
    ]);
    expect(findNumericTotalSeries(r, ["a", "b", "c"])).toBeNull();
  });

  it("candidates restrict who may be the total, and minCells lowers the evidence bar for a single bar-chart slot", () => {
    const one = [{ Capital: 10, Muharraq: 20, Northern: 30, "Kingdom of Bahrain": 60 }];
    const keys = ["Capital", "Muharraq", "Northern", "Kingdom of Bahrain"];
    expect(findNumericTotalSeries(one, keys)).toBeNull(); // one cell is not enough by default
    expect(findNumericTotalSeries(one, keys, { minCells: 1 })).toBe("Kingdom of Bahrain");
    expect(findNumericTotalSeries(one, keys, { minCells: 1, candidates: ["Capital"] })).toBeNull();
  });

  it("a quorum of 80% of the comparable periods is enough (one restated period does not hide the total)", () => {
    const r = rows([
      { a: 10, b: 20, t: 30 },
      { a: 11, b: 20, t: 31 },
      { a: 12, b: 20, t: 32 },
      { a: 13, b: 20, t: 33 },
      { a: 14, b: 20, t: 99 },
    ]);
    expect(findNumericTotalSeries(r, ["a", "b", "t"])).toBe("t");
    const noisy = [...r.slice(0, 3), { period: "x", a: 1, b: 1, t: 50 }, { period: "y", a: 1, b: 1, t: 50 }];
    expect(findNumericTotalSeries(noisy, ["a", "b", "t"])).toBeNull();
  });

  it("totalCellsAgree (record-level): candidate = siblings in every cell and never below the largest sibling", () => {
    const cell = (candidate: number, siblings: number, maxSibling: number, siblingCount = 2) => ({ candidate, siblings, maxSibling, siblingCount, allIntegers: true });
    expect(totalCellsAgree([cell(100, 100, 60), cell(110, 110, 70), cell(120, 120, 80)])).toBe(true);
    expect(totalCellsAgree([cell(100, 100, 60), cell(110, 110, 70)])).toBe(false); // two cells
    expect(totalCellsAgree([cell(10, 90, 10, 9), cell(10, 90, 10, 9), cell(10, 90, 10, 9)])).toBe(false); // 'Total Imports' among 9 parts
    expect(totalCellsAgree([cell(100, 100, 100, 1), cell(100, 100, 100, 1), cell(100, 100, 100, 1)])).toBe(false); // one sibling
  });
});

describe("r3-02: which labels may nominate a total", () => {
  it.each([
    ["Total (all)", true],
    ["Total Population", true],
    ["Total, all", true],
    ["Total-all", true],
    ["All", true],
    ["all nationalities", true],
    ["Both sexes", true],
    ["Both", true],
    ["Kingdom of Bahrain", true],
    ["Bahrain", true],
    ["المملكة", true],
    ["مملكة البحرين", true],
    ["جميع الجنسيات", true],
    ["كلا الجنسين", true],
    // strict totals are accepted by label alone, so they are not "candidates"; parts are nothing
    ["Total", false],
    ["الإجمالي", false],
    ["Bahraini", false],
    ["Allied forces", false],
    ["Male", false],
    ["", false],
  ])("%j -> %s", (label, expected) => {
    expect(isTotalCandidateLabel(label)).toBe(expected);
  });
});

describe("r3-04: identifier-like names (whole label only)", () => {
  it.each([
    "Phone",
    "Mobile No",
    "Tel",
    "CPR Number",
    "cpr_number",
    "Building",
    "Building No",
    "Road",
    "Road No.",
    "Block",
    "Block Number",
    "Flat",
    "PO Box",
    "License Number",
    "licence_no",
    "Registration No",
    "Permit Number",
    "Case Number",
    "رقم الهاتف",
    "الهاتف",
    "المبنى",
    "رقم الرخصة",
    "طريق",
  ])("%j is an identifier name", (name) => {
    expect(isIdentifierLikeName(name)).toBe(true);
  });

  it.each([
    "Road Accidents",
    "Building Permits",
    "Passengers Number",
    "Total Number",
    "Vehicles No",
    "Road Length (km)",
    "Zone Population",
    "Plot Area",
    "Number of Units",
    "Cases",
    "Permit",
    "Number of Registrations",
    "Block Count",
    "الرقم القياسي",
    "رقم قياسي",
    "عدد المباني",
    "طريقة",
    "Students",
    "",
  ])("%j is NOT", (name) => {
    expect(isIdentifierLikeName(name)).toBe(false);
  });
});

describe("r3-01: series names / dimensions that cannot be partitions", () => {
  // "price" is in the non-additive set on purpose (a series called "Price" next to "Quantity" must never be summed);
  // the accepted cost is a withheld headline for a partition that has a series literally called "Price ...".
  it.each(["Unemployment Rate (%)", "Male (%)", "Average Price", "Price Index", "Deaths per 1000", "Ratio", "Mean wage", "معدل البطالة", "نسبة المشاركة", "مؤشر الأسعار", "متوسط الأجر"])(
    "%j is non-additive",
    (name) => expect(isNonAdditiveSeriesName(name)).toBe(true),
  );

  it.each(["Primary Level", "Secondary Level", "Level 1", "Low Density Housing", "Bahraini", "Unemployed Persons", "Labour Force", "مستوى ابتدائي", "المدارس المتوسطة"])("%j is not", (name) =>
    expect(isNonAdditiveSeriesName(name)).toBe(false),
  );

  it.each([
    ["indicator", "Indicator"],
    ["indicator_name", ""],
    ["Measure", ""],
    ["", "Metric"],
    ["dataType", ""],
    ["data_type", "Data type"],
    ["pollutant", ""],
    ["", "Parameter"],
    ["x", "المؤشر"],
    ["x", "البند"],
  ])("dimension %j / %j is an indicator dimension", (name, label) => {
    expect(isIndicatorDimensionName(name, label)).toBe(true);
  });

  it.each([
    ["school_type", "Type of School"],
    ["nationality", "Nationality"],
    ["category", "Category"],
    ["type", "Type"],
    ["governorate", "Governorate"],
  ])("dimension %j / %j is a partition dimension", (name, label) => {
    expect(isIndicatorDimensionName(name, label)).toBe(false);
  });
});
