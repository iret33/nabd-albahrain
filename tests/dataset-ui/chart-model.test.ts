import { describe, expect, it } from "vitest";
import {
  OTHER_LABEL,
  OTHER_SERIES_COLOR,
  PARTIAL_SUFFIX,
  TOTAL_DASH,
  axisNumberFormatter,
  canvasSize,
  categoryAxisWidth,
  isolatedIndices,
  partialPeriodOf,
  seriesSpecs,
  splitPartial,
  truncateLabel,
  valueAxisWidth,
  valueExtent,
} from "@/lib/chart-model";
import { SERIES_COLORS, TOTAL_SERIES_COLOR } from "@/lib/theme-colors";
import type { VizConfig } from "@/lib/sync/derived";

const BASE = "#3D6B8C";

const multi = (seriesValues: string[], extra: Record<string, unknown> = {}) =>
  ({
    type: "multi-line",
    geoFields: [],
    temporalField: "y",
    temporalLabel: "Year",
    grain: "year",
    measureField: "v",
    measureLabel: "Value",
    aggregate: "sum",
    seriesField: "s",
    seriesLabel: "Series",
    seriesValues,
    seriesOverflow: false,
    ...extra,
  }) as VizConfig;

describe("seriesSpecs", () => {
  it("gives single-series types one spec in the theme color", () => {
    const area = { type: "area", geoFields: [], temporalField: "y", temporalLabel: "Y", grain: "year", measureField: "v", measureLabel: "Visitors", aggregate: "sum" } as VizConfig;
    expect(seriesSpecs(area, BASE)).toEqual([{ key: "value", label: "Visitors", color: BASE, total: false }]);
    const hist = { type: "histogram", geoFields: [], measureField: "v", measureLabel: "Age", binCount: 10, min: 0, max: 1 } as VizConfig;
    expect(seriesSpecs(hist, BASE)).toEqual([{ key: "count", label: "العدد", color: BASE, total: false }]);
  });

  it("keeps the total neutral and dashed, and out of the palette", () => {
    const specs = seriesSpecs(multi(["Total", "A", "B"], { totalKey: "Total" }), BASE);
    expect(specs[0]).toMatchObject({ key: "Total", color: TOTAL_SERIES_COLOR, dash: TOTAL_DASH, total: true });
    expect(specs[1].total).toBe(false);
    expect(SERIES_COLORS).toContain(specs[1].color as (typeof SERIES_COLORS)[number]);
    expect(specs[1].color).not.toBe(specs[2].color);
  });

  it("ignores a totalKey that is not among the series", () => {
    const specs = seriesSpecs(multi(["A", "B"], { totalKey: "Gone" }), BASE);
    expect(specs.every((s) => !s.total)).toBe(true);
  });

  it("adds a dash cue from the fifth series on", () => {
    const specs = seriesSpecs(multi(["a", "b", "c", "d", "e", "f"]), BASE);
    expect(specs.slice(0, 4).every((s) => s.dash === undefined)).toBe(true);
    expect(specs[4].dash).toBeDefined();
    expect(specs[5].dash).toBeDefined();
    expect(specs[4].dash).not.toBe(specs[5].dash);
  });

  it("colors the aggregated 'other' stack neutral", () => {
    const stacked = {
      type: "bar-stacked", geoFields: [], xField: "x", xLabel: "X", seriesField: "s", seriesLabel: "S",
      seriesValues: ["A", "B", OTHER_LABEL], seriesOverflow: true, measureField: "v", measureLabel: "V",
      aggregate: "sum", otherBucketed: false, otherSeriesBucketed: true,
    } as VizConfig;
    const specs = seriesSpecs(stacked, BASE);
    expect(specs.map((s) => s.key)).toEqual(["A", "B", OTHER_LABEL]);
    expect(specs[2].color).toBe(OTHER_SERIES_COLOR);
    expect(specs[0].color).not.toBe(OTHER_SERIES_COLOR);
  });

  it("returns nothing for a table", () => {
    expect(seriesSpecs({ type: "table", geoFields: [], reason: "geo" }, BASE)).toEqual([]);
  });
});

describe("canvasSize", () => {
  it("reserves a fixed responsive box for time series and histograms", () => {
    expect(canvasSize(multi(["a"]), 500)).toEqual({ className: "h-72 sm:h-80" });
  });
  it("grows bars with their categories within bounds", () => {
    const barH = { type: "bar-h" } as VizConfig;
    expect(canvasSize(barH, 3).height).toBe(240);
    expect(canvasSize(barH, 10).height).toBe(340);
    expect(canvasSize(barH, 100).height).toBe(560);
    const stacked = { type: "bar-stacked" } as VizConfig;
    expect(canvasSize(stacked, 2).height).toBe(280);
    expect(canvasSize(stacked, 100).height).toBe(520);
  });
});

describe("axis numbers", () => {
  it("is compact from 1,000 up", () => {
    const f = axisNumberFormatter(1_512_345);
    expect(f(1_500_000)).toBe("1.5M");
    expect(f(0)).toBe("0");
    expect(f(2000)).toBe("2K");
    expect(f(-250_000)).toBe("-250K");
  });

  it("keeps enough decimals that neighbouring small ticks stay distinct", () => {
    const f = axisNumberFormatter(0.8);
    expect(f(0.25)).toBe("0.25");
    expect(f(0.5)).toBe("0.5");
    expect(axisNumberFormatter(5)(1.25)).toBe("1.25");
    expect(axisNumberFormatter(50)(12.5)).toBe("12.5");
    expect(axisNumberFormatter(500)(125)).toBe("125");
    expect(axisNumberFormatter(0.004)(0.0015)).toBe("0.0015");
  });

  it("sizes the axis from the longest tick, within bounds", () => {
    const wide = valueAxisWidth(axisNumberFormatter(1_512_345), 0, 1_512_345);
    const narrow = valueAxisWidth(axisNumberFormatter(9), 0, 9);
    expect(wide).toBeGreaterThan(narrow);
    expect(narrow).toBeGreaterThanOrEqual(36);
    const negative = valueAxisWidth(axisNumberFormatter(1000), -1000, 1000);
    expect(negative).toBeGreaterThanOrEqual(valueAxisWidth(axisNumberFormatter(1000), 0, 1000));
    expect(valueAxisWidth(axisNumberFormatter(5e12), -5e12, 5e12)).toBeLessThanOrEqual(96);
  });

  it("measures the extent of plain and stacked series, ignoring nulls", () => {
    const rows = [
      { a: 3, b: 4 },
      { a: -2, b: null },
      { a: "x", b: 10 },
    ];
    expect(valueExtent(rows, ["a", "b"], false)).toEqual({ min: -2, max: 10 });
    expect(valueExtent(rows, ["a", "b"], true)).toEqual({ min: -2, max: 10 });
    expect(valueExtent(rows, ["a"], true)).toEqual({ min: -2, max: 3 });
    expect(valueExtent([], ["a"], false)).toEqual({ min: 0, max: 0 });
  });
});

describe("labels", () => {
  it("truncates long labels by characters, not bytes", () => {
    expect(truncateLabel("short", 10)).toBe("short");
    expect(truncateLabel("abcdefghij", 5)).toBe("abcd…");
    expect(truncateLabel("😀😀😀😀😀😀", 4)).toBe("😀😀😀…");
  });

  it("fits the category axis to the longest label within bounds", () => {
    expect(categoryAxisWidth(["a", "bb"], 24)).toBe(80);
    expect(categoryAxisWidth(["x".repeat(100)], 24)).toBeLessThanOrEqual(200);
    expect(categoryAxisWidth(["x".repeat(24)], 24)).toBeGreaterThan(categoryAxisWidth(["x".repeat(10)], 24));
  });
});

describe("isolatedIndices", () => {
  it("finds points surrounded by gaps, which a line would not draw", () => {
    expect(isolatedIndices([1, null, 3, 4, null, 6])).toEqual(new Set([0, 5]));
    expect(isolatedIndices([null, 2, null])).toEqual(new Set([1]));
    expect(isolatedIndices([1, 2, 3])).toEqual(new Set());
    expect(isolatedIndices([])).toEqual(new Set());
    expect(isolatedIndices([5])).toEqual(new Set([0]));
  });
});

describe("splitPartial", () => {
  it("moves the last value to a twin that starts at the previous point", () => {
    const rows = [
      { period: "2023", value: 1, b: 10 },
      { period: "2024", value: 2, b: null },
      { period: "2025", value: 3, b: 30 },
    ];
    const out = splitPartial(rows, ["value", "b"]);
    expect(out[2]).toMatchObject({ value: null, [`value${PARTIAL_SUFFIX}`]: 3, b: null, [`b${PARTIAL_SUFFIX}`]: 30 });
    expect(out[1]).toMatchObject({ value: 2, [`value${PARTIAL_SUFFIX}`]: 2, [`b${PARTIAL_SUFFIX}`]: null });
    expect(out[0][`value${PARTIAL_SUFFIX}`]).toBeNull();
  });

  it("does not mutate its input and leaves short series alone", () => {
    const rows = [{ period: "2025", value: 3 }];
    expect(splitPartial(rows, ["value"])).toEqual(rows);
    const two = [{ period: "a", value: 1 }, { period: "b", value: 2 }];
    splitPartial(two, ["value"]);
    expect(two[1].value).toBe(2);
  });
});

describe("partialPeriodOf", () => {
  const rows = [{ period: "2025" }, { period: "2026" }];
  it("returns the trailing period only for a flagged temporal chart with data", () => {
    expect(partialPeriodOf(multi(["a"], { lastPeriodPartial: true }), rows)).toBe("2026");
    expect(partialPeriodOf(multi(["a"], { lastPeriodPartial: false }), rows)).toBeNull();
    expect(partialPeriodOf(multi(["a"], { lastPeriodPartial: true }), [rows[0]])).toBeNull();
    expect(partialPeriodOf({ type: "bar-h" } as VizConfig, rows)).toBeNull();
  });
});
