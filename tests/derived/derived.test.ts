import { describe, expect, it, vi } from "vitest";
import { derive, field, months, years, type Rec } from "./helpers";
import type { VizConfig } from "@/lib/sync/derived";

// Realistic fixtures modeled on the datasets described in the audit findings and README
// (airport passengers, port containers, population by nationality, CPI, unemployment, imports).

describe("airport passengers: a labeled 'Total' series next to its own components (multi-line)", () => {
  const types = ["Passengers Total", "Passengers Disembark", "Passengers Transfers", "Passengers Embark", "Passengers Transit"];
  const parts: Record<string, number> = { "Passengers Disembark": 400, "Passengers Transfers": 50, "Passengers Embark": 400, "Passengers Transit": 150 };
  const total = 1000;
  const records: Rec[] = [];
  for (const [i, ym] of months(2024, 2025).entries()) {
    for (const t of types) {
      const base = t === "Passengers Total" ? total : parts[t];
      records.push({ month: `${ym}-01`, data_type: t, value: base + i * 10, n: records.length + 1 });
    }
  }
  const fields = [field("month", "date", "Month"), field("data_type", "text", "Data type"), field("value", "double", "Value"), field("n", "int", "N")];

  it("charts the total as its own series and records totalKey", async () => {
    const { viz, rows } = await derive(records, fields);
    expect(viz.type).toBe("multi-line");
    if (viz.type !== "multi-line") return;
    expect(viz.totalKey).toBe("Passengers Total");
    expect(viz.seriesValues[0]).toBe("Passengers Total");
    expect(viz.seriesValues).toHaveLength(5);
    expect(viz.aggregate).toBe("sum");
    expect(viz.grain).toBe("month");
    expect(rows).toHaveLength(24);
    expect(rows[23]).toMatchObject({ period: "2025-12", "Passengers Total": 1230 });
  });

  it("the headline and the summary sentence use the total, not total + parts", async () => {
    const { viz, summaryAr } = await derive(records, fields);
    if (viz.type !== "multi-line") throw new Error("expected multi-line");
    expect(viz.headline).toMatchObject({ value: 1230, period: "2025-12", prevValue: 1220, prevPeriod: "2025-11", basis: "total-series" });
    expect(summaryAr).toBe("آخر قيمة مسجلة: 1,230 في ديسمبر 2025، بتغير +0.8% عن الفترة السابقة.");
    expect(summaryAr).not.toContain("2,");
  });

  it("is a partition-free chart: nothing was dropped, nothing is hidden", async () => {
    const { viz } = await derive(records, fields);
    if (viz.type !== "multi-line") throw new Error("expected multi-line");
    expect(viz.excludedTotals).toBeUndefined();
    expect(viz.hiddenDimensions).toBeUndefined();
    expect(viz.lastPeriodPartial).toBe(false);
    expect(viz.periodStep).toBe(1);
  });
});

describe("imports/exports: several 'Total X' series is ambiguous, not 'first match wins'", () => {
  const records: Rec[] = [];
  for (const y of years(2018, 2025)) {
    records.push({ year: String(y), flow: "Total Imports", value: 9000 + y });
    records.push({ year: String(y), flow: "Total Exports", value: 10000 + y });
    records.push({ year: String(y), flow: "Re-exports", value: 7000 + y });
  }
  const fields = [field("year", "text", "Year"), field("flow", "text", "Flow"), field("value", "double", "Value")];

  it("keeps all three as legitimate series, has no totalKey and no headline", async () => {
    const { viz, summaryAr } = await derive(records, fields);
    if (viz.type !== "multi-line") throw new Error("expected multi-line");
    expect(viz.seriesValues.sort()).toEqual(["Re-exports", "Total Exports", "Total Imports"]);
    expect(viz.totalKey).toBeNull();
    expect(viz.headline).toBeNull();
    // no made-up number: the generic sentence
    expect(summaryAr).toBe("تحتوي قاعدة البيانات على 24 سجلاً عبر 3 حقلاً.");
  });
});

describe("Total rows on a hidden dimension are never summed with their parts", () => {
  it("area: 9 nationalities + 'Total' (not series-able, so summed): parts only", async () => {
    const nations = ["BH", "SA", "AE", "KW", "QA", "OM", "IN", "PK", "EG"];
    const records: Rec[] = [];
    for (const y of years(2020, 2025)) {
      for (const n of nations) records.push({ year: String(y), nationality: n, value: 10 });
      records.push({ year: String(y), nationality: "Total", value: 90 });
    }
    const { viz, rows } = await derive(records, [
      field("year", "text", "Year"),
      field("nationality", "text", "Nationality"),
      field("value", "int", "Value"),
    ]);
    expect(viz.type).toBe("area");
    if (viz.type !== "area") return;
    expect(rows.map((r) => r.value)).toEqual([90, 90, 90, 90, 90, 90]); // was 180
    expect(viz.excludedTotals).toEqual(["Total"]);
    expect(viz.hiddenDimensions).toEqual(["Nationality"]);
    expect(viz.headline).toMatchObject({ value: 90, period: "2025", prevValue: 90, changePct: 0 });
  });

  it("multi-line: the Total on the OTHER (hidden) dimension is dropped, the plotted dimension keeps its own total", async () => {
    const records: Rec[] = [];
    for (const y of years(2020, 2024)) {
      for (const sex of ["Male", "Female", "Total"]) {
        for (const nat of ["Bahraini", "Non-Bahraini", "Total"]) {
          const v = sex === "Total" ? 100 : 50;
          records.push({ year: String(y), sex, nationality: nat, value: nat === "Total" ? v * 2 : v });
        }
      }
    }
    const { viz, rows } = await derive(records, [
      field("year", "text", "Year"),
      field("sex", "text", "Sex"),
      field("nationality", "text", "Nationality"),
      field("value", "int", "Value"),
    ]);
    if (viz.type !== "multi-line") throw new Error("expected multi-line");
    // series dimension is the first seriesable one in schema order: sex, whose "Total" stays its own series
    expect(viz.seriesField).toBe("sex");
    expect(viz.totalKey).toBe("Total");
    // nationality's Total rows were dropped: Male = 50 (Bahraini) + 50 (Non-Bahraini) = 100
    expect(rows[0]).toMatchObject({ period: "2020", Male: 100, Female: 100, Total: 200 });
    expect(viz.excludedTotals).toEqual(["Total"]);
  });

  it("a hidden dimension with > 30 values (never a classified dimension) is still scanned for its Total", async () => {
    const records: Rec[] = [];
    for (const y of years(2021, 2024)) {
      for (let i = 0; i < 40; i++) records.push({ year: String(y), country: `Country ${i}`, value: 1 });
      records.push({ year: String(y), country: "Total", value: 40 });
    }
    const { viz, rows } = await derive(records, [
      field("year", "text", "Year"),
      field("country", "text", "Country"),
      field("value", "int", "Value"),
    ]);
    if (viz.type !== "area") throw new Error("expected area");
    expect(rows.map((r) => r.value)).toEqual([40, 40, 40, 40]); // was 80
    expect(viz.excludedTotals).toEqual(["Total"]);
  });

  it("a Total that appears only after the 1,000-distinct cap is still recognised", async () => {
    const records: Rec[] = [];
    for (const y of years(2021, 2022)) {
      for (let i = 0; i < 1100; i++) records.push({ year: String(y), commodity: `c${i}`, value: 1 });
      records.push({ year: String(y), commodity: "Total", value: 1100 });
    }
    const { rows } = await derive(records, [
      field("year", "text", "Year"),
      field("commodity", "text", "Commodity"),
      field("value", "int", "Value"),
    ]);
    expect(rows.map((r) => r.value)).toEqual([1100, 1100]);
  });

  it("bar-stacked: a 'Total' x-category is left out (was the tallest bar and the 'top category')", async () => {
    const records: Rec[] = [];
    for (const [gov, vals] of Object.entries({ Capital: [20, 35], Northern: [30, 20], Total: [50, 55] })) {
      records.push({ type: "Public", governorate: gov, value: vals[0] });
      records.push({ type: "Private", governorate: gov, value: vals[1] });
    }
    const { viz, rows, summaryAr } = await derive(records, [
      field("type", "text", "Type"),
      field("governorate", "text", "Governorate"),
      field("value", "int", "Value"),
    ]);
    if (viz.type !== "bar-stacked") throw new Error("expected bar-stacked");
    expect(rows.map((r) => r.category).sort()).toEqual(["Capital", "Northern"]);
    expect(viz.excludedTotals).toEqual(["Total"]);
    expect(summaryAr).toBe("الفئة الأعلى: «Capital» بقيمة 55.");
  });

  it("bar-stacked: a 'Total' series is left out of the stack", async () => {
    const records: Rec[] = [];
    for (const gov of ["Capital", "Northern", "Southern", "Muharraq"]) {
      records.push({ gov, kind: "Public", value: 10 });
      records.push({ gov, kind: "Private", value: 5 });
      records.push({ gov, kind: "Total", value: 15 });
    }
    const { viz, rows } = await derive(records, [field("gov", "text", "Governorate"), field("kind", "text", "Kind"), field("value", "int", "Value")]);
    if (viz.type !== "bar-stacked") throw new Error("expected bar-stacked");
    expect(viz.seriesValues.sort()).toEqual(["Private", "Public"]);
    expect(rows[0]).not.toHaveProperty("Total");
    expect(viz.excludedTotals).toEqual(["Total"]);
  });

  it("bar-h: a 'Total' category is not the top category", async () => {
    const records: Rec[] = [
      { sector: "Industry", value: 10 },
      { sector: "Services", value: 30 },
      { sector: "Agriculture", value: 2 },
      { sector: "Total", value: 42 },
    ];
    const { viz, rows, summaryAr } = await derive(records, [field("sector", "text", "Sector"), field("value", "int", "Value")]);
    if (viz.type !== "bar-h") throw new Error("expected bar-h");
    expect(rows.map((r) => r.category)).toEqual(["Services", "Industry", "Agriculture"]);
    expect(viz.categoryCount).toBe(3);
    expect(viz.excludedTotals).toEqual(["Total"]);
    expect(summaryAr).toBe("الفئة الأعلى: «Services» بقيمة 30 من أصل 3 فئة.");
  });

  it("negative: 'Total Imports' as a legitimate part is NOT dropped on a hidden dimension", async () => {
    const records: Rec[] = [];
    for (const y of years(2020, 2024)) {
      for (const flow of ["Total Imports", "Total Exports", "Re-exports", "Other 1", "Other 2", "Other 3", "Other 4", "Other 5", "Other 6", "Other 7"]) {
        records.push({ year: String(y), flow, value: 10 });
      }
    }
    const { viz, rows } = await derive(records, [field("year", "text", "Year"), field("flow", "text", "Flow"), field("value", "int", "Value")]);
    if (viz.type !== "area") throw new Error("expected area");
    expect(rows.map((r) => r.value)).toEqual([100, 100, 100, 100, 100]);
    expect(viz.excludedTotals).toBeUndefined();
  });

  it("fallback: when dropping totals would leave NOTHING, the whole dataset keeps them (no per-period mixing)", async () => {
    // two hidden dimensions (> 8 values each, so neither is a series); every row is a total on one of them
    const records: Rec[] = [];
    for (const y of years(2020, 2023)) {
      for (let k = 1; k <= 9; k++) records.push({ year: String(y), g1: "Total", g2: `H${k}`, value: 10 });
      for (let k = 1; k <= 9; k++) records.push({ year: String(y), g1: `G${k}`, g2: "Total", value: 10 });
    }
    const { viz, rows } = await derive(records, [
      field("year", "text", "Year"),
      field("g1", "text", "G1"),
      field("g2", "text", "G2"),
      field("value", "int", "Value"),
    ]);
    expect(viz.type).toBe("area");
    if (viz.type !== "area") return;
    expect(rows.map((r) => r.value)).toEqual([180, 180, 180, 180]); // nothing dropped, nothing mixed
    expect(viz.excludedTotals).toBeUndefined();
  });
});

describe("aggregate inference end to end", () => {
  const yearly = (label: string, name = "value") => {
    const records: Rec[] = [];
    for (const y of years(2020, 2023)) for (const c of ["A", "B", "C"]) records.push({ year: String(y), cat: c, [name]: 10 });
    return derive(records, [field("year", "text", "Year"), field("cat", "text", "Cat"), field(name, "double", label)]);
  };

  it("'Number of Registrations' is SUMMED (was averaged because 'ratio' sits inside registRATIOn)", async () => {
    const { viz, rows } = await yearly("Number of Registrations", "registrations");
    if (viz.type !== "multi-line") throw new Error("expected multi-line");
    expect(viz.aggregate).toBe("sum");
    expect(rows[0]).toMatchObject({ A: 10, B: 10, C: 10 });
  });

  it.each(["Consumer Price Index", "Price", "Index", "Temperature", "Level", "Unemployment Rate", "Share (%)"])("%j is a mean", async (label) => {
    const records: Rec[] = [];
    // two rows per (year, category): a sum would be 20, the mean is 10
    for (const y of years(2020, 2023)) for (const c of ["A", "B"]) for (let k = 0; k < 2; k++) records.push({ year: String(y), cat: c, value: 10 });
    const { viz, rows } = await derive(records, [field("year", "text", "Year"), field("cat", "text", "Cat"), field("value", "double", label)]);
    if (viz.type !== "multi-line") throw new Error("expected multi-line");
    expect(viz.aggregate).toBe("mean");
    expect(rows[0]).toMatchObject({ A: 10, B: 10 });
    // a mean over several series has no headline
    expect(viz.headline).toBeNull();
  });

  it("the unit from a '(%)' label suffix is persisted when annotations.unit is absent", async () => {
    const { viz } = await yearly("Unemployment (%)");
    if (viz.type !== "multi-line") throw new Error("expected multi-line");
    expect(viz.unit).toBe("%");
    expect(viz.aggregate).toBe("mean");
  });

  it("annotations.unit wins over the label fallback", async () => {
    const records: Rec[] = years(2020, 2023).map((y) => ({ year: String(y), value: y }));
    const { viz } = await derive(records, [field("year", "text", "Year"), field("value", "double", "Area (km2)", { unit: "m2" })]);
    expect(viz.type).toBe("area");
    expect((viz as Extract<VizConfig, { type: "area" }>).unit).toBe("m2");
  });

  it("label parenthetical unit: Area (km2) -> km2", async () => {
    const records: Rec[] = years(2020, 2023).map((y) => ({ year: String(y), value: y }));
    const { viz } = await derive(records, [field("year", "text", "Year"), field("value", "double", "Area (km2)")]);
    expect((viz as Extract<VizConfig, { type: "area" }>).unit).toBe("km2");
  });

  it("bar-stacked means are not stacked (stacked:false) and the summary says 'average'", async () => {
    const records: Rec[] = [];
    for (const gov of ["Capital", "Northern", "Southern"]) {
      for (const kind of ["Public", "Private"]) {
        records.push({ gov, kind, rate: gov === "Capital" ? 40 : 10 });
        records.push({ gov, kind, rate: gov === "Capital" ? 60 : 20 });
      }
    }
    const { viz, rows, summaryAr } = await derive(records, [field("gov", "text", "Governorate"), field("kind", "text", "Kind"), field("rate", "double", "Unemployment Rate")]);
    if (viz.type !== "bar-stacked") throw new Error("expected bar-stacked");
    expect(viz.aggregate).toBe("mean");
    expect(viz.stacked).toBe(false);
    expect(rows.find((r) => r.category === "Capital")).toMatchObject({ Public: 50, Private: 50 });
    expect(summaryAr).toBe("الفئة الأعلى: «Capital» بمتوسط 50.");
  });

  it("bar-stacked sums are stacked", async () => {
    const records: Rec[] = [];
    for (const gov of ["Capital", "Northern"]) for (const kind of ["Public", "Private"]) records.push({ gov, kind, value: 5 });
    const { viz } = await derive(records, [field("gov", "text", "Governorate"), field("kind", "text", "Kind"), field("value", "int", "Value")]);
    if (viz.type !== "bar-stacked") throw new Error("expected bar-stacked");
    expect(viz.stacked).toBe(true);
  });

  it("measure tie-break is scale-free: a percent column does not lose to a population column just for having larger raw variance", async () => {
    const records: Rec[] = [];
    for (const y of years(2010, 2024)) records.push({ year: String(y), population: 1_000_000 + (y % 2) * 1000, share: 10 + (y - 2010) * 3 });
    const { viz } = await derive(records, [field("year", "text", "Year"), field("population", "int", "Population"), field("share", "double", "Share (%)")]);
    // population's relative spread is ~0.0005, the share's ~0.4: the more informative column is plotted
    expect((viz as Extract<VizConfig, { type: "area" }>).measureField).toBe("share");
  });
});

describe("viz overrides", () => {
  const records: Rec[] = [];
  for (const y of years(2020, 2023)) for (const c of ["A", "B"]) records.push({ year: String(y), cat: c, stock: 100 + y, flow: 5 });
  const fields = [field("year", "text", "Year"), field("cat", "text", "Cat"), field("stock", "int", "Stock"), field("flow", "int", "Flow")];

  it("measureField pins the measure", async () => {
    const { viz } = await derive(records, fields, { measureField: "flow" });
    expect((viz as Extract<VizConfig, { type: "multi-line" }>).measureField).toBe("flow");
  });

  it("aggregate: 'last' takes the latest observation of each period (stock values)", async () => {
    const daily: Rec[] = [];
    for (let d = 1; d <= 31; d++) daily.push({ date: `2024-01-${String(d).padStart(2, "0")}`, balance: d });
    for (let d = 1; d <= 28; d++) daily.push({ date: `2024-02-${String(d).padStart(2, "0")}`, balance: 100 + d });
    const flds = [field("date", "date", "Date"), field("balance", "int", "Balance")];
    const last = await derive(daily, flds, { aggregate: "last" });
    expect(last.rows).toEqual([
      { period: "2024-01", value: 31 },
      { period: "2024-02", value: 128 },
    ]);
    expect((last.viz as Extract<VizConfig, { type: "area" }>).aggregate).toBe("last");
    const sum = await derive(daily, flds);
    expect(sum.rows[0]).toEqual({ period: "2024-01", value: 496 }); // the default would add the month's balances up
  });

  it("seriesField pins the series dimension", async () => {
    const recs: Rec[] = [];
    for (const y of years(2020, 2023)) for (const a of ["x", "y"]) for (const b of ["p", "q", "r"]) recs.push({ year: String(y), a, b, value: 1 });
    const flds = [field("year", "text", "Year"), field("a", "text", "A"), field("b", "text", "B"), field("value", "int", "Value")];
    const dflt = await derive(recs, flds);
    expect((dflt.viz as Extract<VizConfig, { type: "multi-line" }>).seriesField).toBe("a");
    const pinned = await derive(recs, flds, { seriesField: "b" });
    expect((pinned.viz as Extract<VizConfig, { type: "multi-line" }>).seriesField).toBe("b");
  });

  it("an override that cannot be applied logs a warning and falls back (never silent)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { viz } = await derive(records, fields, { measureField: "nope", seriesField: "nope2" });
      expect(viz.type).toBe("multi-line");
      expect(warn).toHaveBeenCalledTimes(2);
      expect(warn.mock.calls.map((c) => String(c[0])).join("\n")).toMatch(/measureField "nope"[\s\S]*seriesField "nope2"/);
    } finally {
      warn.mockRestore();
    }
  });

  it("the configured CPI override applies to its dataset id only", async () => {
    const { computeDerivedFields } = await import("@/lib/sync/derived");
    const recs: Rec[] = [];
    for (const y of years(2020, 2023)) for (let m = 1; m <= 12; m++) recs.push({ year: String(y), reading_value: 100 + m });
    // a neutral label: the heuristics alone say "sum", so "mean" can only come from the override
    const f = [field("year", "text", "Year"), field("reading_value", "int", "Reading")];
    const cpi = await computeDerivedFields("01-consumer-price-index-division-and-group-index-number", recs, f);
    const other = await computeDerivedFields("some-other-dataset", recs, f);
    expect((cpi.vizConfig as Extract<VizConfig, { type: "area" }>).aggregate).toBe("mean");
    expect((other.vizConfig as Extract<VizConfig, { type: "area" }>).aggregate).toBe("sum");
    expect(cpi.chartData?.[0]).toEqual({ period: "2020", value: 106.5 });
  });
});

describe("partial trailing period", () => {
  // CPI-like: 4 categories x 12 monthly rows per year (the month column itself is not exported);
  // the current year has only 6 months of rows.
  function cpiLike(lastYearMonths: number): Rec[] {
    const records: Rec[] = [];
    for (const y of years(2020, 2026)) {
      const upTo = y === 2026 ? lastYearMonths : 12;
      for (let m = 1; m <= upTo; m++) for (const c of ["A", "B", "C", "D"]) records.push({ year: String(y), cat: c, value: 100 });
    }
    return records;
  }
  const fields = [field("year", "text", "Year"), field("cat", "text", "Cat"), field("value", "int", "Value")];

  it("flags 2026 as partial and never headlines it (was '-49.5%')", async () => {
    const { viz, summaryAr, rows } = await derive(cpiLike(6), fields);
    if (viz.type !== "multi-line") throw new Error("expected multi-line");
    expect(viz.lastPeriodPartial).toBe(true);
    expect(viz.headline).toEqual({ value: 400 * 12, period: "2025", prevValue: null, prevPeriod: null, changePct: null, basis: "sum-of-series" });
    expect(summaryAr).toBe("آخر قيمة مسجلة لفترة مكتملة: 4,800 في 2025، علماً بأن بيانات 2026 غير مكتملة.");
    // the chart still carries the partial point so it can be drawn dashed
    expect(rows[rows.length - 1]).toMatchObject({ period: "2026" });
  });

  it("a complete last year is not flagged and keeps its % change", async () => {
    const { viz, summaryAr } = await derive(cpiLike(12), fields);
    if (viz.type !== "multi-line") throw new Error("expected multi-line");
    expect(viz.lastPeriodPartial).toBe(false);
    expect(summaryAr).toContain("في 2026");
    expect(summaryAr).toContain("+0.0%");
  });

  it("area chart: same rule", async () => {
    const recs: Rec[] = [];
    for (const y of years(2018, 2026)) for (let k = 0; k < (y === 2026 ? 5 : 12); k++) recs.push({ year: String(y), value: 10 });
    const { viz } = await derive(recs, [field("year", "text", "Year"), field("value", "int", "Value")]);
    if (viz.type !== "area") throw new Error("expected area");
    expect(viz.lastPeriodPartial).toBe(true);
    expect(viz.headline).toMatchObject({ period: "2025", value: 120, changePct: null });
  });

  it("mean aggregates are never flagged (they are not distorted by partial periods)", async () => {
    const recs: Rec[] = [];
    for (const y of years(2018, 2026)) for (let k = 0; k < (y === 2026 ? 3 : 12); k++) recs.push({ year: String(y), rate: 4 });
    const { viz } = await derive(recs, [field("year", "text", "Year"), field("rate", "double", "Unemployment Rate")]);
    if (viz.type !== "area") throw new Error("expected area");
    expect(viz.aggregate).toBe("mean");
    expect(viz.lastPeriodPartial).toBe(false);
    expect(viz.headline?.period).toBe("2026");
  });

  it("a year-only table with one row per year cannot be judged (documented limit)", async () => {
    const recs: Rec[] = years(2018, 2026).map((y) => ({ year: String(y), value: y === 2026 ? 5 : 10 }));
    const { viz } = await derive(recs, [field("year", "text", "Year"), field("value", "int", "Value")]);
    if (viz.type !== "area") throw new Error("expected area");
    expect(viz.lastPeriodPartial).toBe(false);
  });

  it("is evaluated before downsampling: 700 months, the last one half-filled", async () => {
    const recs: Rec[] = [];
    const all = months(1960, 2018); // 708 months
    for (const [i, ym] of all.entries()) {
      const n = i === all.length - 1 ? 2 : 4;
      for (let k = 0; k < n; k++) recs.push({ date: `${ym}-01`, value: 1 });
    }
    const { viz, rows } = await derive(recs, [field("date", "date", "Date"), field("value", "int", "Value")]);
    if (viz.type !== "area") throw new Error("expected area");
    expect(rows.length).toBeLessThanOrEqual(500);
    expect(rows[rows.length - 1]).toMatchObject({ period: "2018-12" });
    expect(viz.lastPeriodPartial).toBe(true);
  });
});

describe("month periods and the 'Month' column", () => {
  it("month periods are formatted as an Arabic month name + year in the summary", async () => {
    const recs: Rec[] = [];
    for (const ym of months(2025, 2026).slice(0, 15)) recs.push({ date: `${ym}-15`, value: 100 });
    const { summaryAr, viz } = await derive(recs, [field("date", "date", "Date"), field("value", "int", "Value")]);
    expect(viz.type).toBe("area");
    expect(summaryAr).toContain("مارس 2026");
    expect(summaryAr).not.toMatch(/\d{4}-\d{2}/);
  });

  it("a text 'Month' column of 1..12 + a Year column become 'YYYY-MM' periods (grain month)", async () => {
    const recs: Rec[] = [];
    for (const y of [2024, 2025]) for (let m = 1; m <= 12; m++) recs.push({ year: String(y), month: String(m), value: m * 10 });
    const { viz, rows } = await derive(recs, [field("year", "text", "Year"), field("month", "text", "Month"), field("value", "int", "Value")]);
    if (viz.type !== "area") throw new Error("expected area");
    expect(viz.grain).toBe("month");
    expect(viz.temporalField).toBe("year");
    expect(viz.temporalMonthField).toBe("month");
    expect(rows).toHaveLength(24);
    expect(rows[0]).toEqual({ period: "2024-01", value: 10 });
    expect(rows[23]).toEqual({ period: "2025-12", value: 120 });
    expect(viz.hiddenDimensions).toBeUndefined(); // the month column is consumed by the period
  });

  it("an int 'Month' column is not a measure either (it used to be picked as the plotted measure)", async () => {
    const recs: Rec[] = [];
    for (const y of [2024, 2025]) for (let m = 1; m <= 12; m++) recs.push({ year: y, month: m, passengers: 1000 + m });
    const { viz } = await derive(recs, [field("year", "int", "Year"), field("month", "int", "Month"), field("passengers", "int", "Passengers")]);
    if (viz.type !== "area") throw new Error("expected area");
    expect(viz.measureField).toBe("passengers");
    expect(viz.grain).toBe("month");
  });

  it("month NAMES combine with the year too", async () => {
    const names = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    const recs: Rec[] = [];
    for (const y of [2024, 2025]) for (const [i, n] of names.entries()) recs.push({ year: String(y), month: n, value: i + 1 });
    const { rows } = await derive(recs, [field("year", "text", "Year"), field("month", "text", "Month"), field("value", "int", "Value")]);
    expect(rows[0]).toEqual({ period: "2024-01", value: 1 });
    expect(rows[11]).toEqual({ period: "2024-12", value: 12 });
  });

  it("a 'Month' column with NO sibling year is not a temporal field (was '2001-01'..'2001-12')", async () => {
    const recs: Rec[] = [];
    for (let m = 1; m <= 12; m++) recs.push({ month: String(m), value: m * 10 });
    const { viz, rows } = await derive(recs, [field("month", "text", "Month"), field("value", "int", "Value")]);
    expect(viz.type).not.toBe("area");
    expect(viz.type).not.toBe("multi-line");
    for (const r of rows) expect(String(r.period ?? "")).not.toMatch(/2001/);
  });

  it("'Item 12'-style text in a date-named column is not temporal", async () => {
    const recs: Rec[] = [];
    for (let i = 1; i <= 12; i++) recs.push({ date_label: `Item ${i}`, value: i });
    const { viz } = await derive(recs, [field("date_label", "text", "Date label"), field("value", "int", "Value")]);
    expect(viz.type).not.toBe("area");
  });
});

describe("gaps are visible, regular cadences are not broken", () => {
  it("missing years are filled with null rows (2015, 2016, 2019)", async () => {
    const recs: Rec[] = [2015, 2016, 2019].map((y) => ({ year: String(y), value: y }));
    const { rows, viz } = await derive(recs, [field("year", "text", "Year"), field("value", "int", "Value")]);
    expect(rows).toEqual([
      { period: "2015", value: 2015 },
      { period: "2016", value: 2016 },
      { period: "2017", value: null },
      { period: "2018", value: null },
      { period: "2019", value: 2019 },
    ]);
    if (viz.type !== "area") throw new Error("expected area");
    expect(viz.headline).toMatchObject({ value: 2019, prevValue: 2016, prevPeriod: "2016" });
  });

  it("multi-line gap rows carry a null per series", async () => {
    const recs: Rec[] = [];
    for (const y of [2020, 2021, 2023]) for (const s of ["A", "B"]) recs.push({ year: String(y), s, value: 1 });
    const { rows } = await derive(recs, [field("year", "text", "Year"), field("s", "text", "S"), field("value", "int", "Value")]);
    expect(rows[2]).toEqual({ period: "2022", A: null, B: null });
    expect(rows).toHaveLength(4);
  });

  it("quarterly data in 'YYYY-MM' is not broken into isolated points", async () => {
    const recs: Rec[] = [];
    for (const y of [2023, 2024]) for (const m of ["01", "04", "07", "10"]) recs.push({ date: `${y}-${m}-01`, value: 5 });
    const { rows, viz } = await derive(recs, [field("date", "date", "Date"), field("value", "int", "Value")]);
    expect(rows).toHaveLength(8);
    expect(rows.every((r) => r.value === 5)).toBe(true);
    if (viz.type !== "area") throw new Error("expected area");
    expect(viz.periodStep).toBe(3);
  });
});

describe("text year columns use the year grain (was month grain, charting '2025-01' for a yearly series)", () => {
  it("text and int year columns", async () => {
    for (const mk of [(y: number) => String(y), (y: number) => y]) {
      const recs: Rec[] = years(2018, 2022).map((y) => ({ year: mk(y), value: y }));
      const type = typeof mk(2018) === "number" ? "int" : "text";
      const { viz, rows } = await derive(recs, [field("year", type, "Year"), field("value", "int", "Value")]);
      if (viz.type !== "area") throw new Error("expected area");
      expect(viz.grain).toBe("year");
      expect(rows[0].period).toBe("2018");
    }
  });
});

describe("histogram labels stay unique for narrow ranges", () => {
  it("min 0.001, max 0.02 (was '0–0', '0–0', '0–0.01' ...)", async () => {
    const recs: Rec[] = [];
    for (let i = 0; i < 40; i++) recs.push({ value: 0.001 + (i * 0.019) / 39 });
    const { viz, rows } = await derive(recs, [field("value", "double", "Value")]);
    if (viz.type !== "histogram") throw new Error("expected histogram");
    const labels = rows.map((r) => r.bucket as string);
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels[0]).toBe("0.0010–0.0029");
    expect(viz.min).toBe(0.001);
    expect(viz.max).toBe(0.02);
  });

  it("min 100, max 100.9 (an edge-magnitude rule collapsed these to '100-101')", async () => {
    const recs: Rec[] = [];
    for (let i = 0; i < 40; i++) recs.push({ value: 100 + (i * 0.9) / 39 });
    const { rows } = await derive(recs, [field("value", "double", "Value")]);
    const labels = rows.map((r) => r.bucket as string);
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels[0]).toBe("100.00–100.09");
  });

  it("wide ranges get grouped integers", async () => {
    const recs: Rec[] = [];
    for (let i = 0; i < 40; i++) recs.push({ value: i * 1000 });
    const { rows } = await derive(recs, [field("value", "int", "Value")]);
    expect(rows[0].bucket).toBe("0–3,900");
    const total = rows.reduce((s, r) => s + (r.count as number), 0);
    expect(total).toBe(40);
  });
});

describe("bar-stacked overflow keeps stack heights complete", () => {
  it("with more than 8 real series the 8th slot is the aggregated 'أخرى'", async () => {
    const recs: Rec[] = [];
    for (const x of ["P", "Q"]) for (let s = 0; s < 12; s++) recs.push({ s: `S${String(s).padStart(2, "0")}`, x, value: s + 1 });
    // make `s` (12 values) the SERIES by giving `x` more distinct values than `s`
    for (let i = 0; i < 14; i++) recs.push({ s: "S00", x: `X${i}`, value: 1 });
    const { viz, rows } = await derive(recs, [field("s", "text", "S"), field("x", "text", "X"), field("value", "int", "Value")]);
    if (viz.type !== "bar-stacked") throw new Error("expected bar-stacked");
    expect(viz.seriesField).toBe("s");
    expect(viz.seriesOverflow).toBe(true);
    expect(viz.otherSeriesBucketed).toBe(true);
    expect(viz.seriesValues).toHaveLength(8);
    expect(viz.seriesValues[7]).toBe("أخرى");
    const p = rows.find((r) => r.category === "P")!;
    const stack = viz.seriesValues.reduce((a, k) => a + ((p[k] as number | null) ?? 0), 0);
    expect(stack).toBe((12 * 13) / 2); // 1+2+...+12, nothing lost
  });
});

describe("golden configs per chart type (unrelated behavior must not regress)", () => {
  it("area", async () => {
    const recs: Rec[] = years(2018, 2022).map((y) => ({ year: String(y), value: (y - 2017) * 100 }));
    const out = await derive(recs, [field("year", "date", "Year"), field("value", "int", "Value")]);
    expect(out.vizConfig).toEqual({
      type: "area",
      geoFields: [],
      temporalField: "year",
      temporalLabel: "Year",
      grain: "year",
      measureField: "value",
      measureLabel: "Value",
      aggregate: "sum",
      headline: { value: 500, period: "2022", prevValue: 400, prevPeriod: "2021", changePct: 25, basis: "single" },
      lastPeriodPartial: false,
      periodStep: 1,
    });
    expect(out.chartData).toEqual([
      { period: "2018", value: 100 },
      { period: "2019", value: 200 },
      { period: "2020", value: 300 },
      { period: "2021", value: 400 },
      { period: "2022", value: 500 },
    ]);
    expect(out.summaryAr).toBe("آخر قيمة مسجلة: 500 في 2022، بتغير +25.0% عن الفترة السابقة.");
  });

  it("multi-line", async () => {
    const recs: Rec[] = [];
    for (const y of [2020, 2021, 2022]) {
      recs.push({ year: String(y), nationality: "Bahraini", value: 700 + (y - 2020) * 10 });
      recs.push({ year: String(y), nationality: "Non-Bahraini", value: 840 + (y - 2020) * 20 });
    }
    const out = await derive(recs, [field("year", "text", "Year"), field("nationality", "text", "Nationality"), field("value", "int", "Value")]);
    expect(out.vizConfig).toEqual({
      type: "multi-line",
      geoFields: [],
      temporalField: "year",
      temporalLabel: "Year",
      grain: "year",
      measureField: "value",
      measureLabel: "Value",
      aggregate: "sum",
      seriesField: "nationality",
      seriesLabel: "Nationality",
      seriesValues: ["Non-Bahraini", "Bahraini"],
      seriesOverflow: false,
      totalKey: null,
      headline: { value: 1600, period: "2022", prevValue: 1570, prevPeriod: "2021", changePct: 1.91, basis: "sum-of-series" },
      lastPeriodPartial: false,
      periodStep: 1,
    });
    expect(out.chartData).toEqual([
      { period: "2020", "Non-Bahraini": 840, Bahraini: 700 },
      { period: "2021", "Non-Bahraini": 860, Bahraini: 710 },
      { period: "2022", "Non-Bahraini": 880, Bahraini: 720 },
    ]);
  });

  it("bar-h", async () => {
    const recs: Rec[] = [
      { sector: "Industry", value: 10 },
      { sector: "Services", value: 30 },
      { sector: "Agriculture", value: 2 },
    ];
    const out = await derive(recs, [field("sector", "text", "Sector"), field("value", "int", "Value")]);
    expect(out.vizConfig).toEqual({
      type: "bar-h",
      geoFields: [],
      dimensionField: "sector",
      dimensionLabel: "Sector",
      measureField: "value",
      measureLabel: "Value",
      aggregate: "sum",
      categoryCount: 3,
      otherBucketed: false,
    });
    expect(out.chartData).toEqual([
      { category: "Services", value: 30 },
      { category: "Industry", value: 10 },
      { category: "Agriculture", value: 2 },
    ]);
  });

  it("bar-h with more than 15 categories buckets the rest into 'أخرى' (sum)", async () => {
    const recs: Rec[] = [];
    for (let i = 0; i < 20; i++) recs.push({ cat: `C${String(i).padStart(2, "0")}`, other: i % 2 === 0 ? "x" : "y", value: 20 - i });
    const out = await derive(recs, [field("cat", "text", "Cat"), field("value", "int", "Value")]);
    // cat has 20 distinct values (a dimension, 2..30), bar-h
    if (out.viz.type !== "bar-h") throw new Error("expected bar-h");
    expect(out.rows).toHaveLength(16);
    expect(out.rows[15]).toEqual({ category: "أخرى", value: 5 + 4 + 3 + 2 + 1 });
    expect(out.viz.otherBucketed).toBe(true);
    expect(out.viz.categoryCount).toBe(20);
  });

  it("bar-stacked", async () => {
    const recs: Rec[] = [
      { type: "Public", governorate: "Capital", value: 20 },
      { type: "Private", governorate: "Capital", value: 35 },
      { type: "Public", governorate: "Northern", value: 30 },
      { type: "Private", governorate: "Northern", value: 25 },
    ];
    const out = await derive(recs, [field("type", "text", "Type"), field("governorate", "text", "Governorate"), field("value", "int", "Value")]);
    expect(out.vizConfig).toEqual({
      type: "bar-stacked",
      geoFields: [],
      xField: "governorate",
      xLabel: "Governorate",
      seriesField: "type",
      seriesLabel: "Type",
      seriesValues: ["Private", "Public"],
      seriesOverflow: false,
      measureField: "value",
      measureLabel: "Value",
      aggregate: "sum",
      otherBucketed: false,
      stacked: true,
    });
    expect(out.chartData).toEqual([
      { category: "Capital", Private: 35, Public: 20 },
      { category: "Northern", Private: 25, Public: 30 },
    ]);
    expect(out.summaryAr).toBe("الفئة الأعلى: «Capital» بقيمة 55.");
  });

  it("histogram", async () => {
    const recs: Rec[] = [];
    for (let i = 0; i < 40; i++) recs.push({ amount: i * 5 });
    const out = await derive(recs, [field("amount", "int", "Amount")]);
    expect(out.vizConfig).toEqual({
      type: "histogram",
      geoFields: [],
      measureField: "amount",
      measureLabel: "Amount",
      binCount: 10,
      min: 0,
      max: 195,
    });
    expect(out.rows).toHaveLength(10);
    expect(out.rows.reduce((s, r) => s + (r.count as number), 0)).toBe(40);
    expect(out.summaryAr).toBe("تحتوي قاعدة البيانات على 40 سجلاً عبر 1 حقلاً.");
  });

  it("table: geo", async () => {
    const recs: Rec[] = [
      { name: "A", geo: { lat: 26.1, lon: 50.5 } },
      { name: "B", geo: { lat: 26.2, lon: 50.6 } },
    ];
    const out = await derive(recs, [field("name", "text", "Name"), field("geo", "geo_point_2d", "Location")]);
    expect(out.vizConfig).toEqual({ type: "table", geoFields: [{ name: "geo", label: "Location", type: "geo_point_2d" }], reason: "geo" });
    expect(out.chartData).toBeNull();
  });

  it("table: no-viz", async () => {
    const out = await derive([{ a: "x" }, { a: "y" }, { a: "z" }].map((r, i) => ({ ...r, note: `n${i}` })), [field("a", "text", "A"), field("note", "text", "Note")]);
    expect(out.vizConfig).toMatchObject({ type: "table", reason: "no-viz" });
    expect(out.chartData).toBeNull();
  });

  it("no fields / empty records", async () => {
    const none = await derive([{ a: 1 }], []);
    expect(none.vizConfig).toBeNull();
    expect(none.summaryAr).toBe("تحتوي قاعدة البيانات على 1 سجلاً عبر 0 حقلاً.");
    const empty = await derive([], [field("year", "text", "Year"), field("value", "int", "Value")]);
    expect(empty.vizConfig).toMatchObject({ type: "table" });
  });
});

describe("robustness: null / NaN / odd values never throw and never leak into charts", () => {
  it("handles nulls, NaN, strings and objects in measure and temporal cells", async () => {
    const recs: Rec[] = [
      { year: "2020", value: 10 },
      { year: "2021", value: null },
      { year: "2022", value: "abc" },
      { year: null, value: 5 },
      { year: "2023", value: Number.NaN },
      { year: { x: 1 }, value: 3 },
      { year: "2024", value: "12" },
      { year: "2025", value: 14 },
      { year: "2026", value: Infinity },
      ...years(2012, 2019).map((y) => ({ year: String(y), value: y - 2000 })),
    ];
    const out = await derive(recs, [field("year", "text", "Year"), field("value", "int", "Value")]);
    expect(out.vizConfig).not.toBeNull();
    for (const r of out.rows) {
      for (const v of Object.values(r)) {
        if (typeof v === "number") expect(Number.isFinite(v)).toBe(true);
      }
    }
  });

  it("huge numbers stay finite and readable", async () => {
    const recs: Rec[] = years(2018, 2022).map((y) => ({ year: String(y), value: 1e15 + y }));
    const out = await derive(recs, [field("year", "text", "Year"), field("value", "double", "Value")]);
    expect(out.summaryAr).toMatch(/^آخر قيمة مسجلة: [\d,]+ في 2022/);
  });
});

describe("field stats additions", () => {
  const recs: Rec[] = [];
  for (let i = 0; i < 20; i++) {
    recs.push({
      year: i % 2 === 0 ? 2020 : 2021,
      civil_id: 100000 + i,
      amount: (i % 5) + 1, // 1,2,3,4,5 repeated: median 3
      phone_no: `0097333${100000 + i}`,
      zip: String(1000 + i),
      note: i < 18 ? String(i * 1000) : "n/a", // 90% numeric text
      label: `label ${i}`,
      seq: i + 1,
    });
  }
  const fields = [
    field("year", "int", "Year"),
    field("civil_id", "int", "Civil ID"),
    field("amount", "int", "Amount"),
    field("phone_no", "text", "Phone No"),
    field("zip", "text", "Zip"),
    field("note", "text", "Note"),
    field("label", "text", "Label"),
    field("seq", "int", "Seq"),
  ];

  it("median, numericLike, looksLikeYear, looksLikeIdentifier", async () => {
    const { statsJson } = await derive(recs, fields);
    const s = statsJson!;
    expect(s.amount.median).toBe(3);
    expect(s.amount.mean).toBe(3);
    expect(s.year.looksLikeYear).toBe(true);
    expect(s.year.looksLikeIdentifier).toBeUndefined();
    expect(s.amount.looksLikeYear).toBeUndefined(); // 1..5 is no year
    expect(s.civil_id.looksLikeIdentifier).toBe(true);
    expect(s.civil_id.looksLikeYear).toBeUndefined();
    expect(s.seq.looksLikeIdentifier).toBe(true); // dense 1..n row index
    expect(s.phone_no.numericLike).toBe(true);
    expect(s.phone_no.looksLikeIdentifier).toBe(true);
    expect(s.zip.numericLike).toBe(true);
    expect(s.zip.looksLikeIdentifier).toBe(true);
    expect(s.note.numericLike).toBe(true); // 18 of 20 = 90%
    expect(s.note.looksLikeIdentifier).toBeUndefined();
    expect(s.label.numericLike).toBeUndefined();
    expect(s.label.median).toBeUndefined();
  });

  it("numericLike needs >= 90%", async () => {
    const r: Rec[] = [];
    for (let i = 0; i < 20; i++) r.push({ v: i < 17 ? String(i) : "x" });
    const { statsJson } = await derive(r, [field("v", "text", "V")]);
    expect(statsJson!.v.numericLike).toBeUndefined();
  });

  it("numeric strings with thousands separators count, a lone sign or '1-2' does not", async () => {
    const r: Rec[] = [{ v: "1,234" }, { v: "5,000.5" }, { v: "-3" }, { v: "+4" }, { v: "1-2" }, { v: "-" }, { v: "." }, { v: "12 3" }];
    const { statsJson } = await derive(r, [field("v", "text", "V")]);
    expect(statsJson!.v.numericLike).toBeUndefined(); // only 4 of 8
  });

  it("looksLikeYear on a text year column", async () => {
    const r: Rec[] = years(2010, 2020).map((y) => ({ year: String(y) }));
    const { statsJson } = await derive(r, [field("year", "text", "Year")]);
    expect(statsJson!.year.numericLike).toBe(true);
    expect(statsJson!.year.looksLikeYear).toBe(true);
  });

  it("the median of a large field is a deterministic sample (reservoir), within a tight band", async () => {
    const r: Rec[] = [];
    for (let i = 0; i < 25000; i++) r.push({ v: i });
    const a = (await derive(r, [field("v", "int", "V")])).statsJson!.v.median!;
    const b = (await derive(r, [field("v", "int", "V")])).statsJson!.v.median!;
    expect(a).toBe(b);
    expect(Math.abs(a - 12500)).toBeLessThan(500);
  });
});
