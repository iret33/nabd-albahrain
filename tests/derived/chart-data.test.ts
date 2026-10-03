import { describe, expect, it } from "vitest";
import {
  chartCaption,
  chartCaptionParts,
  extractFeaturedMetric,
  extractTrendSeries,
  looksTemporal,
  sparklinePath,
  summarizeSeries,
} from "@/lib/chart-data";
import type { VizConfig } from "@/lib/sync/derived";
import oldShapes from "./fixtures/old-shapes.json";

type Cfg = Record<string, unknown>;
const asViz = (c: Cfg) => c as unknown as VizConfig;

describe("extractFeaturedMetric: reads the persisted headline", () => {
  const vizConfig = asViz({
    type: "multi-line",
    grain: "month",
    aggregate: "sum",
    seriesValues: ["Total", "A"],
    seriesOverflow: false,
    totalKey: "Total",
    lastPeriodPartial: false,
    headline: { value: 110, period: "2025-02", prevValue: 100, prevPeriod: "2025-01", changePct: 10, basis: "total-series" },
    unit: "BHD",
  });
  const chartData = [
    { period: "2025-01", Total: 100, A: 60 },
    { period: "2025-02", Total: 110, A: 70 },
  ];

  it("value/period come from vizConfig.headline, points from the shared trend rules", () => {
    const m = extractFeaturedMetric(vizConfig, chartData);
    expect(m).toEqual({
      value: 110,
      period: "2025-02",
      unit: "BHD",
      points: [
        { x: "2025-01", y: 100 },
        { x: "2025-02", y: 110 },
      ],
      changePct: 10,
      prevValue: 100,
      prevPeriod: "2025-01",
      basis: "total-series",
      partial: false,
    });
  });

  it("headline: null (withheld at sync time) means no metric: cards and the home band skip it", () => {
    expect(extractFeaturedMetric(asViz({ ...(vizConfig as unknown as Cfg), headline: null }), chartData)).toBeNull();
  });

  it("a malformed persisted headline is recomputed instead of trusted", () => {
    const m = extractFeaturedMetric(asViz({ ...(vizConfig as unknown as Cfg), headline: { value: "x" } }), chartData);
    expect(m?.value).toBe(110);
  });

  it("partial trailing period: headline is the last complete one, the sparkline drops the partial point", () => {
    const cfg = asViz({
      type: "area",
      grain: "year",
      aggregate: "sum",
      lastPeriodPartial: true,
      headline: { value: 42403, period: "2025", prevValue: null, prevPeriod: null, changePct: null, basis: "single" },
    });
    const m = extractFeaturedMetric(cfg, [
      { period: "2024", value: 42000 },
      { period: "2025", value: 42403 },
      { period: "2026", value: 21400 },
    ]);
    expect(m?.value).toBe(42403);
    expect(m?.points.map((p) => p.x)).toEqual(["2024", "2025"]);
    expect(m?.partial).toBe(true);
    expect(m?.changePct).toBeNull();
  });

  it("non temporal / empty input", () => {
    expect(extractFeaturedMetric(null, [{ a: 1 }])).toBeNull();
    expect(extractFeaturedMetric(asViz({ type: "bar-h" }), [{ category: "a", value: 1 }])).toBeNull();
    expect(extractFeaturedMetric(asViz({ type: "table", reason: "geo", geoFields: [] }), null)).toBeNull();
    expect(extractFeaturedMetric(vizConfig, [])).toBeNull();
    expect(extractFeaturedMetric(vizConfig, null)).toBeNull();
    expect(looksTemporal(vizConfig)).toBe(true);
    expect(looksTemporal(null)).toBe(false);
    expect(looksTemporal(asViz({ type: "histogram" }))).toBe(false);
  });
});

describe("extractFeaturedMetric: backward compatible with rows synced before this change", () => {
  it("OLD-shaped area vizConfig/chartData (no headline, no totalKey, no lastPeriodPartial) still works", () => {
    const m = extractFeaturedMetric(asViz(oldShapes.energyConsumption.vizConfig), oldShapes.energyConsumption.chartData);
    expect(m).not.toBeNull();
    expect(m?.value).toBe(18620);
    expect(m?.period).toBe("2025-01");
    expect(m?.points).toHaveLength(12);
    expect(m?.changePct).toBeCloseTo(2.31, 1);
    expect(m?.basis).toBe("single");
  });

  it("OLD-shaped multi-line (sum of a clean partition) still works", () => {
    const m = extractFeaturedMetric(asViz(oldShapes.population.vizConfig), oldShapes.population.chartData);
    expect(m?.value).toBe(2233000);
    expect(m?.basis).toBe("sum-of-series");
    expect(m?.points).toHaveLength(16);
  });

  it("OLD-shaped mean area (unemployment rate) still works", () => {
    const m = extractFeaturedMetric(asViz(oldShapes.unemployment.vizConfig), oldShapes.unemployment.chartData);
    expect(m?.value).toBe(3.6);
    expect(m?.period).toBe("2025-10");
  });

  it("OLD-shaped bar-stacked / table configs are not temporal -> null, no crash", () => {
    expect(extractFeaturedMetric(asViz(oldShapes.schools.vizConfig), oldShapes.schools.chartData)).toBeNull();
    expect(extractFeaturedMetric(asViz(oldShapes.airQuality.vizConfig), null)).toBeNull();
  });

  it("an OLD multi-line row carrying a 'Passengers Total' series: the total is found by label (no totalKey persisted)", () => {
    const cfg = asViz({
      type: "multi-line",
      geoFields: [],
      temporalField: "date",
      temporalLabel: "Date",
      grain: "month",
      measureField: "value",
      measureLabel: "Value",
      aggregate: "sum",
      seriesField: "data_type",
      seriesLabel: "Data type",
      seriesValues: ["Passengers Total", "Passengers Embark", "Passengers Disembark"],
      seriesOverflow: false,
    });
    const rows = [
      { period: "2025-01", "Passengers Total": 1000, "Passengers Embark": 500, "Passengers Disembark": 500 },
      { period: "2025-02", "Passengers Total": 1100, "Passengers Embark": 550, "Passengers Disembark": 550 },
    ];
    expect(extractFeaturedMetric(cfg, rows)?.value).toBe(1100);
  });

  it("an OLD multi-line row with 'Total Imports'/'Total Exports': ambiguous -> no metric instead of 'first one wins'", () => {
    const cfg = asViz({
      type: "multi-line",
      seriesValues: ["Total Imports", "Total Exports", "Re-exports"],
      seriesOverflow: false,
      aggregate: "sum",
      grain: "year",
    });
    const rows = [{ period: "2025", "Total Imports": 1, "Total Exports": 2, "Re-exports": 3 }];
    expect(extractFeaturedMetric(cfg, rows)).toBeNull();
  });

  it("an OLD mean multi-line (male + female rates) no longer yields a summed fake headline", () => {
    const cfg = asViz({ type: "multi-line", seriesValues: ["Male", "Female"], seriesOverflow: false, aggregate: "mean", grain: "year" });
    expect(extractFeaturedMetric(cfg, [{ period: "2025", Male: 3.1, Female: 6.2 }])).toBeNull();
  });

  it("an OLD row whose last period lost a series does not show a fake drop", () => {
    const cfg = asViz({ type: "multi-line", seriesValues: ["A", "B"], seriesOverflow: false, aggregate: "sum", grain: "year" });
    const rows = [
      { period: "2023", A: 80, B: 80 },
      { period: "2024", A: 100, B: 100 },
      { period: "2025", A: 100, B: null },
    ];
    const m = extractFeaturedMetric(cfg, rows);
    expect(m?.value).toBe(200);
    expect(m?.period).toBe("2024");
    expect(m?.points.map((p) => p.y)).toEqual([160, 200]);
  });

  it("garbage shapes never throw", () => {
    expect(extractFeaturedMetric(asViz({ type: "area" }), [null, 3, "x", { period: 5 }] as unknown[])).toBeNull();
    expect(extractFeaturedMetric(asViz({ type: "multi-line" }), [{ period: "2025" }])).toBeNull();
    expect(extractFeaturedMetric(asViz({ type: "area", headline: 5 }), [{ period: "2025", value: 1 }])?.value).toBe(1);
  });
});

describe("extractTrendSeries", () => {
  it("includePartial keeps the dashed point for drawing the whole chart", () => {
    const cfg = asViz({ type: "area", aggregate: "sum", lastPeriodPartial: true });
    const rows = [
      { period: "2024", value: 1 },
      { period: "2025", value: 2 },
      { period: "2026", value: 1 },
    ];
    expect(extractTrendSeries(cfg, rows)?.points).toHaveLength(2);
    const full = extractTrendSeries(cfg, rows, { includePartial: true });
    expect(full?.points).toHaveLength(3);
    expect(full?.partialPeriod).toBe("2026");
  });
});

describe("summarizeSeries", () => {
  const monthly = Array.from({ length: 24 }, (_, i) => ({
    x: `${2024 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`,
    y: 100 + i * 5,
  }));

  it("month grain: latest, MoM change, YoY vs the same month a year earlier, peak and trough", () => {
    const s = summarizeSeries(monthly, "month");
    expect(s.latest).toEqual({ period: "2025-12", value: 215 });
    expect(s.prev).toEqual({ period: "2025-11", value: 210 });
    expect(s.changePct).toBeCloseTo((5 / 210) * 100, 5);
    expect(s.yoyPct).toBeCloseTo(((215 - 155) / 155) * 100, 5); // vs 2024-12
    expect(s.min).toEqual({ period: "2024-01", value: 100 });
    expect(s.max).toEqual({ period: "2025-12", value: 215 });
    expect(s.partial).toBe(false);
  });

  it("year grain: YoY is the previous year", () => {
    const s = summarizeSeries(
      [
        { x: "2023", y: 100 },
        { x: "2024", y: 120 },
        { x: "2025", y: 90 },
      ],
      "year",
    );
    expect(s.latest?.value).toBe(90);
    expect(s.changePct).toBeCloseTo(-25, 5);
    expect(s.yoyPct).toBeCloseTo(-25, 5);
    expect(s.max).toEqual({ period: "2024", value: 120 });
  });

  it("YoY is null when the comparable period is missing (gap), not the nearest one", () => {
    const s = summarizeSeries(
      [
        { x: "2020", y: 100 },
        { x: "2022", y: 120 },
      ],
      "year",
    );
    expect(s.yoyPct).toBeNull();
    expect(s.changePct).toBeCloseTo(20, 5); // vs the latest earlier point; prev.period says which
    expect(s.prev?.period).toBe("2020");
  });

  it("partial: the incomplete trailing point is excluded from every figure", () => {
    const pts = [
      { x: "2024", y: 100 },
      { x: "2025", y: 110 },
      { x: "2026", y: 5 },
    ];
    const s = summarizeSeries(pts, "year", { partial: true });
    expect(s.partial).toBe(true);
    expect(s.latest).toEqual({ period: "2025", value: 110 });
    expect(s.min).toEqual({ period: "2024", value: 100 });
    expect(s.changePct).toBeCloseTo(10, 5);
    const naive = summarizeSeries(pts, "year");
    expect(naive.latest?.value).toBe(5);
    expect(naive.changePct).toBeLessThan(-90);
  });

  it("zero previous, empty, single and non-finite inputs", () => {
    expect(summarizeSeries([{ x: "2024", y: 0 }, { x: "2025", y: 5 }], "year").changePct).toBeNull();
    const empty = summarizeSeries([], "year");
    expect(empty).toEqual({ latest: null, prev: null, changePct: null, yoyPct: null, min: null, max: null, partial: false });
    expect(summarizeSeries([{ x: "2025", y: 5 }], "year")).toMatchObject({ prev: null, changePct: null, yoyPct: null });
    expect(summarizeSeries([{ x: "2025", y: Number.NaN }], "year").latest).toBeNull();
    expect(summarizeSeries([], "year", { partial: true }).partial).toBe(false);
  });
});

describe("sparklinePath", () => {
  it("returns an open line and a closed area, scaled to the box, y flipped", () => {
    const { line, area } = sparklinePath([{ y: 0 }, { y: 10 }, { y: 5 }], 100, 40);
    expect(line).toBe("M2 38 L50 2 L98 20");
    expect(area).toBe("M2 38 L50 2 L98 20 L98 40 L2 40 Z");
  });

  it("a flat series sits mid-height", () => {
    expect(sparklinePath([{ y: 7 }, { y: 7 }], 100, 40).line).toBe("M2 20 L98 20");
  });

  it("fewer than 2 finite points -> empty strings", () => {
    expect(sparklinePath([])).toEqual({ line: "", area: "" });
    expect(sparklinePath([{ y: 1 }])).toEqual({ line: "", area: "" });
    expect(sparklinePath([{ y: 1 }, { y: Number.NaN }])).toEqual({ line: "", area: "" });
  });

  it("ignores non-finite points and stays inside the box", () => {
    const { line } = sparklinePath([{ y: 1 }, { y: Number.NaN }, { y: 3 }, { y: Infinity }, { y: 2 }], 200, 50, 3);
    const coords = [...line.matchAll(/[ML]([\d.]+) ([\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
    expect(coords).toHaveLength(3);
    for (const [x, y] of coords) {
      expect(x).toBeGreaterThanOrEqual(3);
      expect(x).toBeLessThanOrEqual(197);
      expect(y).toBeGreaterThanOrEqual(3);
      expect(y).toBeLessThanOrEqual(47);
    }
  });

  it("negative values scale like any other", () => {
    expect(sparklinePath([{ y: -10 }, { y: 10 }], 100, 40).line).toBe("M2 38 L98 2");
  });

  it("handles large arrays without producing NaN", () => {
    const pts = Array.from({ length: 500 }, (_, i) => ({ y: Math.sin(i / 10) * 1e9 }));
    expect(sparklinePath(pts).line).not.toMatch(/NaN|Infinity/);
  });
});

describe("chartCaption", () => {
  const area = {
    type: "area",
    geoFields: [],
    temporalField: "date",
    temporalLabel: "Date",
    grain: "month",
    measureField: "value",
    measureLabel: "Passengers",
    aggregate: "sum",
    unit: "persons",
  };

  it("area: aggregate, measure, unit and grain", () => {
    expect(chartCaption(asViz(area))).toBe("مجموع Passengers (persons) حسب شهر.");
  });

  it("does not repeat a unit that is already in the label", () => {
    expect(chartCaption(asViz({ ...area, measureLabel: "Area (km2)", unit: "km2" }))).toBe("مجموع Area (km2) حسب شهر.");
  });

  it("mean aggregate says it is an average and warns that values are not additive", () => {
    const { title, notes } = chartCaptionParts(asViz({ ...area, aggregate: "mean", measureLabel: "Unemployment Rate", unit: "%", grain: "year" }));
    expect(title).toBe("متوسط Unemployment Rate (%) حسب سنة");
    expect(notes).toContain("القيم متوسطات وليست مجاميع قابلة للجمع");
  });

  it("last aggregate", () => {
    expect(chartCaption(asViz({ ...area, aggregate: "last", unit: undefined, grain: "year" }))).toBe("آخر قيمة مسجلة لـ Passengers حسب سنة.");
  });

  it("notes: aggregated dimensions, excluded totals, partial last period", () => {
    const c = chartCaption(
      asViz({ ...area, unit: undefined, hiddenDimensions: ["Nationality", "Sex"], excludedTotals: ["Total"], lastPeriodPartial: true }),
    );
    expect(c).toBe("مجموع Passengers حسب شهر. مجمّع عبر: Nationality، Sex. استُبعدت صفوف «Total» لتفادي العدّ المزدوج. الفترة الأخيرة غير مكتملة.");
  });

  it("multi-line: series dimension, total kept as its own line, overflow", () => {
    const c = chartCaptionParts(
      asViz({
        ...area,
        type: "multi-line",
        unit: undefined,
        seriesField: "data_type",
        seriesLabel: "Data type",
        seriesValues: ["Passengers Total", "A", "B"],
        seriesOverflow: true,
        totalKey: "Passengers Total",
      }),
    );
    expect(c.title).toBe("مجموع Passengers حسب شهر، موزعاً حسب Data type");
    expect(c.notes).toContain("«Passengers Total» خط مستقل ولا يُجمع مع أجزائه");
    expect(c.notes).toContain("يُعرض أعلى 3 فئات فقط");
  });

  it("bar-h, bar-stacked (grouped when mean, other-series bucket), histogram, table", () => {
    expect(
      chartCaption(asViz({ type: "bar-h", geoFields: [], dimensionField: "s", dimensionLabel: "Sector", measureField: "v", measureLabel: "Value", aggregate: "sum", categoryCount: 20, otherBucketed: true })),
    ).toBe("مجموع Value حسب Sector. تُعرض أعلى الفئات وتُجمع البقية ضمن «أخرى».");

    const stacked = chartCaptionParts(
      asViz({
        type: "bar-stacked",
        geoFields: [],
        xField: "g",
        xLabel: "Governorate",
        seriesField: "t",
        seriesLabel: "Type",
        seriesValues: ["A"],
        seriesOverflow: true,
        measureField: "r",
        measureLabel: "Rate",
        aggregate: "mean",
        otherBucketed: false,
        stacked: false,
        otherSeriesBucketed: true,
      }),
    );
    expect(stacked.title).toBe("متوسط Rate حسب Governorate و Type");
    expect(stacked.notes).toEqual(["القيم متوسطات وليست مجاميع قابلة للجمع", "أعمدة متجاورة وليست متراكمة", "بقية السلاسل مجمّعة ضمن «أخرى»"]);

    expect(chartCaption(asViz({ type: "histogram", geoFields: [], measureField: "a", measureLabel: "Amount", unit: "BHD", binCount: 10, min: 0, max: 1 }))).toBe("توزيع Amount (BHD).");
    expect(chartCaption(asViz({ type: "table", geoFields: [], reason: "geo" }))).toBe("");
    expect(chartCaption(null)).toBe("");
  });

  it("old vizConfig shapes (no new fields) still caption", () => {
    expect(chartCaption(asViz(oldShapes.energyConsumption.vizConfig))).toBe("مجموع Value حسب شهر.");
  });
});
