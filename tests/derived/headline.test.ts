import { describe, expect, it } from "vitest";
import {
  buildHeadlineSentence,
  computeHeadline,
  formatPeriodAr,
  formatSummaryNumber,
  headlineSeries,
  isHeadline,
  withUnit,
  type HeadlineSource,
} from "@/lib/headline";

type Row = Record<string, unknown>;

const multi = (over: Partial<HeadlineSource> = {}): HeadlineSource => ({
  type: "multi-line",
  aggregate: "sum",
  seriesValues: ["A", "B"],
  seriesOverflow: false,
  ...over,
});

describe("headline: area", () => {
  const rows: Row[] = [
    { period: "2023", value: 100 },
    { period: "2024", value: 110 },
    { period: "2025", value: 121 },
  ];
  it("last value + change vs the previous period", () => {
    expect(computeHeadline({ type: "area", aggregate: "sum" }, rows)).toEqual({
      value: 121,
      period: "2025",
      prevValue: 110,
      prevPeriod: "2024",
      changePct: 10,
      basis: "single",
    });
  });

  it("mean area (a rate) still has a headline: it is one series, nothing is summed", () => {
    const h = computeHeadline({ type: "area", aggregate: "mean" }, [
      { period: "2024", value: 3.9 },
      { period: "2025", value: 3.6 },
    ]);
    expect(h).toMatchObject({ value: 3.6, prevValue: 3.9, basis: "single" });
    expect(h?.changePct).toBeCloseTo(-7.69, 2);
  });

  it("null cells (gap-filled periods) are skipped: the previous period is the latest earlier real one", () => {
    const h = computeHeadline({ type: "area" }, [
      { period: "2020", value: 50 },
      { period: "2021", value: null },
      { period: "2022", value: null },
      { period: "2023", value: 75 },
    ]);
    expect(h).toMatchObject({ value: 75, period: "2023", prevValue: 50, prevPeriod: "2020", changePct: 50 });
  });

  it("no change % when the previous value is 0, a single point has no previous", () => {
    expect(computeHeadline({ type: "area" }, [{ period: "2024", value: 0 }, { period: "2025", value: 5 }])).toMatchObject({
      value: 5,
      prevValue: 0,
      changePct: null,
    });
    expect(computeHeadline({ type: "area" }, [{ period: "2025", value: 5 }])).toMatchObject({
      prevValue: null,
      prevPeriod: null,
      changePct: null,
    });
  });

  it("no usable value -> null", () => {
    expect(computeHeadline({ type: "area" }, [])).toBeNull();
    expect(computeHeadline({ type: "area" }, [{ period: "2024", value: null }])).toBeNull();
    expect(computeHeadline({ type: "area" }, [{ period: "2024", value: "x" }])).toBeNull();
    expect(computeHeadline({ type: "area" }, [{ value: 3 }])).toBeNull();
    expect(computeHeadline({ type: "bar-h" }, [{ period: "2024", value: 3 }])).toBeNull();
  });
});

describe("headline: multi-line totals", () => {
  const airport: Row[] = [
    { period: "2025-01", "Passengers Total": 1000, "Passengers Embark": 400, "Passengers Disembark": 400, "Passengers Transit": 200 },
    { period: "2025-02", "Passengers Total": 1100, "Passengers Embark": 440, "Passengers Disembark": 440, "Passengers Transit": 220 },
  ];
  const airportSrc = multi({ seriesValues: ["Passengers Total", "Passengers Embark", "Passengers Disembark", "Passengers Transit"] });

  it("airport: uses the labeled total, never total + parts (was 2,200 instead of 1,100)", () => {
    const h = computeHeadline(airportSrc, airport);
    expect(h).toMatchObject({ value: 1100, period: "2025-02", prevValue: 1000, basis: "total-series" });
    expect(h?.changePct).toBeCloseTo(10, 5);
  });

  it("a persisted totalKey is honoured; without it the loose label match finds the same one (old rows)", () => {
    expect(computeHeadline({ ...airportSrc, totalKey: "Passengers Total" }, airport)?.value).toBe(1100);
    expect(computeHeadline({ ...airportSrc, totalKey: undefined }, airport)?.value).toBe(1100);
  });

  it("a stale totalKey that is not a series falls back to detection instead of crashing", () => {
    expect(computeHeadline({ ...airportSrc, totalKey: "Gone" }, airport)?.value).toBe(1100);
  });

  it("'Total Imports' + 'Total Exports' + 'Re-exports': ambiguous, headline is null (was whichever came first)", () => {
    const src = multi({ seriesValues: ["Total Imports", "Total Exports", "Re-exports"] });
    const rows: Row[] = [
      { period: "2024", "Total Imports": 9000, "Total Exports": 10023, "Re-exports": 7123 },
      { period: "2025", "Total Imports": 9500, "Total Exports": 10500, "Re-exports": 7200 },
    ];
    expect(computeHeadline(src, rows)).toBeNull();
    expect(headlineSeries(src, rows)).toBeNull();
  });

  it("a null total in the last period is skipped, not replaced by a sum of its parts", () => {
    const h = computeHeadline(airportSrc, [...airport, { period: "2025-03", "Passengers Total": null, "Passengers Embark": 1, "Passengers Disembark": 1, "Passengers Transit": 1 }]);
    expect(h).toMatchObject({ value: 1100, period: "2025-02" });
  });
});

describe("headline: multi-line sums and means", () => {
  it("partition without a total is summed", () => {
    const h = computeHeadline(multi(), [
      { period: "2024", A: 40, B: 60 },
      { period: "2025", A: 50, B: 70 },
    ]);
    expect(h).toMatchObject({ value: 120, prevValue: 100, basis: "sum-of-series" });
    expect(h?.changePct).toBeCloseTo(20, 5);
  });

  it("mean aggregate: summing rates is nonsense, so no headline (Male 3.1 + Female 6.2 was 9.3)", () => {
    const src = multi({ aggregate: "mean", seriesValues: ["Male", "Female"] });
    expect(computeHeadline(src, [{ period: "2025", Male: 3.1, Female: 6.2 }])).toBeNull();
  });

  it("mean aggregate with a single total/overall series: that series is the headline", () => {
    const src = multi({ aggregate: "mean", seriesValues: ["Total", "Male", "Female"] });
    const h = computeHeadline(src, [
      { period: "2024", Total: 4.0, Male: 3.0, Female: 6.0 },
      { period: "2025", Total: 4.4, Male: 3.1, Female: 6.2 },
    ]);
    expect(h).toMatchObject({ value: 4.4, prevValue: 4.0, basis: "total-series" });
  });

  it("a series missing in the last period must not look like a drop (was -50%)", () => {
    const rows: Row[] = [
      { period: "2023", A: 80, B: 80 },
      { period: "2024", A: 100, B: 100 },
      { period: "2025", A: 100, B: null },
    ];
    const h = computeHeadline(multi(), rows);
    // the last period is incomplete: the headline is the latest period where every series is present
    expect(h).toMatchObject({ value: 200, period: "2024", prevValue: 160, prevPeriod: "2023" });
    expect(h?.changePct).toBeCloseTo(25, 5);
  });

  it("like-for-like previous period: falls back to the latest earlier period where all series are present", () => {
    const rows: Row[] = [
      { period: "2022", A: 50, B: 50 },
      { period: "2023", A: 60, B: null },
      { period: "2024", A: 70, B: 70 },
    ];
    const h = computeHeadline(multi(), rows);
    expect(h).toMatchObject({ value: 140, period: "2024", prevValue: 100, prevPeriod: "2022" });
  });

  it("overflow (a truncated series list) cannot be summed", () => {
    expect(computeHeadline(multi({ seriesOverflow: true }), [{ period: "2025", A: 1, B: 2 }])).toBeNull();
  });

  it("a single series is 'single', no series at all is null", () => {
    expect(computeHeadline(multi({ seriesValues: ["A"] }), [{ period: "2025", A: 7 }])?.basis).toBe("single");
    expect(computeHeadline(multi({ seriesValues: [] }), [{ period: "2025" }])).toBeNull();
    expect(computeHeadline(multi({ seriesValues: undefined }), [{ period: "2025" }])).toBeNull();
  });
});

describe("headline: partial trailing period", () => {
  const rows: Row[] = [
    { period: "2023", value: 40000 },
    { period: "2024", value: 42000 },
    { period: "2025", value: 42403 },
    { period: "2026", value: 21400 }, // half a year of data: -49.5% is not a real drop
  ];

  it("uses the last COMPLETE period and omits the % change", () => {
    const h = computeHeadline({ type: "area", aggregate: "sum", lastPeriodPartial: true }, rows);
    expect(h).toEqual({ value: 42403, period: "2025", prevValue: null, prevPeriod: null, changePct: null, basis: "single" });
  });

  it("without the flag the same rows would headline the partial year with a fake drop (the bug)", () => {
    const h = computeHeadline({ type: "area", aggregate: "sum" }, rows);
    expect(h).toMatchObject({ value: 21400, period: "2026" });
    expect(h?.changePct).toBeCloseTo(-49.5, 0);
  });

  it("headlineSeries drops the partial point from the sparkline, includePartial keeps it", () => {
    const src: HeadlineSource = { type: "area", aggregate: "sum", lastPeriodPartial: true };
    const s = headlineSeries(src, rows);
    expect(s?.points.map((p) => p.x)).toEqual(["2023", "2024", "2025"]);
    expect(s?.partialPeriod).toBe("2026");
    expect(headlineSeries(src, rows, { includePartial: true })?.points.map((p) => p.x)).toEqual(["2023", "2024", "2025", "2026"]);
  });

  it("works for multi-line with a total series too", () => {
    const src = multi({ seriesValues: ["Total", "A"], lastPeriodPartial: true });
    const h = computeHeadline(src, [
      { period: "2024", Total: 100, A: 60 },
      { period: "2025", Total: 110, A: 70 },
      { period: "2026", Total: 30, A: 20 },
    ]);
    expect(h).toMatchObject({ value: 110, period: "2025", changePct: null, basis: "total-series" });
  });
});

describe("isHeadline", () => {
  it("accepts a persisted headline and rejects malformed ones", () => {
    expect(isHeadline({ value: 1, period: "2025", prevValue: null, prevPeriod: null, changePct: null, basis: "single" })).toBe(true);
    expect(isHeadline(null)).toBe(false);
    expect(isHeadline(undefined)).toBe(false);
    expect(isHeadline("x")).toBe(false);
    expect(isHeadline({ value: "1", period: "2025", basis: "single" })).toBe(false);
    expect(isHeadline({ value: 1, period: 2025, basis: "single" })).toBe(false);
    expect(isHeadline({ value: 1, period: "2025", basis: "nope" })).toBe(false);
    expect(isHeadline({ value: Number.NaN, period: "2025", basis: "single" })).toBe(false);
  });
});

describe("formatSummaryNumber: grouped en-US, magnitude-based digits", () => {
  it.each([
    [1512345, "1,512,345"],
    [1497470.61, "1,497,471"],
    [2233000, "2,233,000"],
    [18620, "18,620"],
    [525, "525"],
    [99.94, "99.94"],
    [12.345, "12.35"],
    [112.37, "112.4"], // an index level keeps its decimal (was "112")
    [3.6, "3.6"],
    [3.456, "3.46"],
    [9.999, "10"],
    [0.5, "0.5"],
    [0.0042, "0.0042"],
    [0.456, "0.46"],
    [0, "0"],
    [-0, "0"],
    [-1234.567, "-1,235"], // Math.abs decides the digits: a negative must not get extra decimals
    [-12.345, "-12.35"],
    [-3.456, "-3.46"],
    [-0.0001, "-0.0001"],
    [Number.NaN, "0"],
    [Infinity, "0"],
  ])("%s -> %s", (n, expected) => {
    expect(formatSummaryNumber(n)).toBe(expected);
  });
});

describe("formatPeriodAr / withUnit", () => {
  it("month periods become 'month-name year' (was '-032026' in an RTL paragraph)", () => {
    expect(formatPeriodAr("2026-03")).toBe("مارس 2026");
    expect(formatPeriodAr("2025-01")).toBe("يناير 2025");
    expect(formatPeriodAr("2025-12")).toBe("ديسمبر 2025");
  });
  it("years and unknown shapes are untouched", () => {
    expect(formatPeriodAr("2026")).toBe("2026");
    expect(formatPeriodAr("2026-13")).toBe("2026-13");
    expect(formatPeriodAr("Q1 2026")).toBe("Q1 2026");
  });
  it("units: % attaches, others are spaced", () => {
    expect(withUnit("5.5", "%")).toBe("5.5%");
    expect(withUnit("1,200", "km2")).toBe("1,200 km2");
    expect(withUnit("1", undefined)).toBe("1");
    expect(withUnit("1", "")).toBe("1");
  });
});

describe("buildHeadlineSentence", () => {
  const base = { value: 1497470.61, period: "2026-03", prevValue: 1460000, prevPeriod: "2026-02", changePct: 2.57, basis: "total-series" as const };

  it("month period, adjacent previous: 'عن الفترة السابقة'", () => {
    expect(buildHeadlineSentence({ headline: base, grain: "month" })).toBe(
      "آخر قيمة مسجلة: 1,497,471 في مارس 2026، بتغير +2.6% عن الفترة السابقة.",
    );
  });

  it("a non-adjacent previous period is named explicitly", () => {
    const h = { ...base, prevPeriod: "2025-11" };
    expect(buildHeadlineSentence({ headline: h, grain: "month" })).toContain("عن نوفمبر 2025");
  });

  it("a quarterly cadence counts as adjacent", () => {
    const h = { ...base, period: "2025-10", prevPeriod: "2025-07" };
    expect(buildHeadlineSentence({ headline: h, grain: "month", step: 3 })).toContain("عن الفترة السابقة");
  });

  it("negative change, unit, no '-0.0%'", () => {
    const down = { ...base, period: "2025", prevPeriod: "2024", changePct: -7.69, value: 3.6 };
    expect(buildHeadlineSentence({ headline: down, grain: "year", unit: "%" })).toBe("آخر قيمة مسجلة: 3.6% في 2025، بتغير -7.7% عن الفترة السابقة.");
    const flat = { ...base, period: "2025", prevPeriod: "2024", changePct: -0.04 };
    // a change that rounds to 0.0 carries no sign at all (neither "+0.0%" nor "-0.0%")
    expect(buildHeadlineSentence({ headline: flat, grain: "year" })).toContain("بتغير 0.0% عن");
    expect(buildHeadlineSentence({ headline: { ...flat, changePct: 0.04 }, grain: "year" })).toContain("بتغير 0.0% عن");
  });

  it("no % clause without a change", () => {
    expect(buildHeadlineSentence({ headline: { ...base, changePct: null, prevPeriod: null, prevValue: null }, grain: "month" })).toBe(
      "آخر قيمة مسجلة: 1,497,471 في مارس 2026.",
    );
  });

  it("partial trailing period: last complete period, no % change, says why", () => {
    const h = { value: 42403, period: "2025", prevValue: null, prevPeriod: null, changePct: null, basis: "single" as const };
    expect(buildHeadlineSentence({ headline: h, grain: "year", partialPeriod: "2026" })).toBe(
      "آخر قيمة مسجلة لفترة مكتملة: 42,403 في 2025، علماً بأن بيانات 2026 غير مكتملة.",
    );
  });
});
