import { describe, expect, it } from "vitest";
import { derive, field, years, type Rec } from "./helpers";
import { extractFeaturedMetric } from "@/lib/chart-data";
import { computeHeadline, type HeadlineSource } from "@/lib/headline";
import type { VizConfig } from "@/lib/sync/derived";

/** Group F3: the numeric total tier and total-only means on the non-temporal chart types, and provisional years with a separate Month column. */

type Stacked = Extract<VizConfig, { type: "bar-stacked" }>;
type BarH = Extract<VizConfig, { type: "bar-h" }>;
type Area = Extract<VizConfig, { type: "area" }>;

describe("r3-02: numeric totals on bar-stacked", () => {
  const GOVS: Record<string, [number, number]> = { Capital: [20, 35], Muharraq: [10, 15], Northern: [30, 20], Southern: [5, 12] };

  it("a national x-row ('Kingdom of Bahrain') that is the sum of the governorates is left out, a look-alike that is not is kept", async () => {
    const mk = (national: [number, number]) => {
      const records: Rec[] = [];
      for (const [g, [pub, priv]] of Object.entries(GOVS)) {
        records.push({ type: "Public", governorate: g, value: pub });
        records.push({ type: "Private", governorate: g, value: priv });
      }
      records.push({ type: "Public", governorate: "Kingdom of Bahrain", value: national[0] });
      records.push({ type: "Private", governorate: "Kingdom of Bahrain", value: national[1] });
      return derive(records, [field("type", "text", "Type"), field("governorate", "text", "Governorate"), field("value", "int", "Value")]);
    };
    const honest = await mk([65, 82]);
    expect(honest.rows.map((r) => r.category)).not.toContain("Kingdom of Bahrain");
    expect((honest.viz as Stacked).excludedTotals).toEqual(["Kingdom of Bahrain"]);
    expect(honest.summaryAr).toBe("الفئة الأعلى: «Capital» بقيمة 55.");

    const notATotal = await mk([10, 10]);
    expect(notATotal.rows.map((r) => r.category)).toContain("Kingdom of Bahrain");
    expect((notATotal.viz as Stacked).excludedTotals).toBeUndefined();
  });

  it("a series called 'All' that is the sum of the other series is not stacked on top of them", async () => {
    const records: Rec[] = [];
    for (const g of ["Capital", "Muharraq", "Northern", "Southern"]) {
      const [a, b] = [10 + g.length, 20 + g.length];
      records.push({ kind: "Public", gov: g, value: a });
      records.push({ kind: "Private", gov: g, value: b });
      records.push({ kind: "All", gov: g, value: a + b });
    }
    const { viz, rows } = await derive(records, [field("kind", "text", "Kind"), field("gov", "text", "Governorate"), field("value", "int", "Value")]);
    expect((viz as Stacked).seriesValues.sort()).toEqual(["Private", "Public"]);
    expect(rows[0]).not.toHaveProperty("All");
    expect((viz as Stacked).excludedTotals).toEqual(["All"]);
  });
});

describe("r3-03: total-only means on bar charts", () => {
  it("bar-h of a rate by governorate with a hidden published 'Total' age row (35 ages: not a classified dimension): the published rates, not the unweighted mean of the ages", async () => {
    const published: Record<string, number> = { Capital: 3, Muharraq: 2, Northern: 4.5, Southern: 2.5 };
    const records: Rec[] = [];
    for (const [g, total] of Object.entries(published)) {
      for (let age = 18; age < 53; age++) records.push({ governorate: g, age_group: `Age ${age}`, rate: age % 2 === 0 ? 10 : 1 });
      records.push({ governorate: g, age_group: "Total", rate: total });
    }
    const { viz, rows } = await derive(records, [field("governorate", "text", "Governorate"), field("age_group", "text", "Age group"), field("rate", "double", "Unemployment Rate (%)")]);
    const v = viz as BarH;
    expect(v.type).toBe("bar-h");
    expect(v.aggregate).toBe("mean");
    expect(v.usedTotals).toEqual(["Total"]);
    expect(v.excludedTotals).toBeUndefined();
    expect(v.hiddenDimensions).toBeUndefined();
    expect(rows.find((r) => r.category === "Capital")?.value).toBe(3);
    expect(rows.find((r) => r.category === "Northern")?.value).toBe(4.5);
  });

  it("a CPI-like index (aggregate pinned to mean) over division x month with an 'All items' style Total: the Total index is used", async () => {
    const records: Rec[] = [];
    for (const y of years(2019, 2024)) {
      for (const d of ["Food", "Housing", "Transport", "Health", "Education", "Clothing", "Recreation", "Other goods", "Hotels", "Communication"]) {
        records.push({ year: String(y), division: d, index_value: 100 + (y - 2019) * 2 + d.length });
      }
      records.push({ year: String(y), division: "Total", index_value: 103 + (y - 2019) * 2 });
    }
    const { viz, rows } = await derive(
      records,
      [field("year", "text", "Year"), field("division", "text", "Division"), field("index_value", "double", "Index")],
      { aggregate: "mean" },
    );
    const v = viz as Area;
    expect(v.type).toBe("area");
    expect(rows[rows.length - 1].value).toBe(113);
    expect(v.usedTotals).toEqual(["Total"]);
  });
});

describe("r3-07: provisional years next to a separate Month column", () => {
  it("year '2025*' + Month 1..12: the months of the provisional year are charted and flagged", async () => {
    const recs: Rec[] = [];
    for (const y of ["2023", "2024", "2025*"]) for (let m = 1; m <= 12; m++) recs.push({ year: y, month: String(m), value: m * 10 });
    const { viz, rows } = await derive(recs, [field("year", "text", "Year"), field("month", "text", "Month"), field("value", "int", "Value")]);
    const v = viz as Area;
    expect(v.grain).toBe("month");
    expect(rows).toHaveLength(36);
    expect(rows[35]).toEqual({ period: "2025-12", value: 120 });
    expect(v.provisionalPeriods).toHaveLength(12);
    expect(v.provisionalPeriods?.[11]).toBe("2025-12");
    expect(v.headline).toMatchObject({ period: "2025-12", provisional: true });
  });
});

describe("rows persisted by the previous engine version (DERIVED_VERSION 2) before they are recomputed", () => {
  it("a v2 multi-line row whose persisted headline is the wrong sum of unrelated indicators yields no card metric", () => {
    const v2 = {
      type: "multi-line",
      geoFields: [],
      temporalField: "year",
      temporalLabel: "Year",
      grain: "year",
      measureField: "value",
      measureLabel: "Value",
      aggregate: "sum",
      seriesField: "indicator",
      seriesLabel: "Indicator",
      seriesValues: ["Labour Force", "Unemployed Persons", "Unemployment Rate (%)"],
      seriesOverflow: false,
      totalKey: null,
      headline: { value: 831027.7, period: "2024", prevValue: 830026.6, prevPeriod: "2023", changePct: 0.12, basis: "sum-of-series" },
      lastPeriodPartial: false,
      periodStep: 1,
    } as unknown as VizConfig;
    const rows = [
      { period: "2023", "Labour Force": 808000, "Unemployed Persons": 22000, "Unemployment Rate (%)": 3.6 },
      { period: "2024", "Labour Force": 809000, "Unemployed Persons": 22400, "Unemployment Rate (%)": 3.6 },
    ];
    expect(extractFeaturedMetric(v2, rows)).toBeNull();
  });

  it("a v2 row of a clean partition with its persisted headline keeps working unchanged", () => {
    const v2 = {
      type: "multi-line",
      grain: "year",
      aggregate: "sum",
      seriesField: "nationality",
      seriesLabel: "Nationality",
      seriesValues: ["Non-Bahraini", "Bahraini"],
      seriesOverflow: false,
      totalKey: null,
      headline: { value: 1600, period: "2022", prevValue: 1570, prevPeriod: "2021", changePct: 1.91, basis: "sum-of-series" },
    } as unknown as VizConfig;
    const rows = [
      { period: "2021", "Non-Bahraini": 860, Bahraini: 710 },
      { period: "2022", "Non-Bahraini": 880, Bahraini: 720 },
    ];
    expect(extractFeaturedMetric(v2, rows)).toMatchObject({ value: 1600, period: "2022", basis: "sum-of-series" });
  });
});

describe("render-time numeric total (rows that predate `totalKey`)", () => {
  const src = (over: Partial<HeadlineSource>): HeadlineSource => ({
    type: "multi-line",
    aggregate: "sum",
    seriesValues: ["Capital", "Muharraq", "Northern", "Kingdom"],
    seriesOverflow: false,
    ...over,
  });
  const rows = [2021, 2022, 2023, 2024].map((y, i) => ({ period: String(y), Capital: 10 + i, Muharraq: 20, Northern: 30 + i, Kingdom: 60 + 2 * i }));

  it("totalKey absent (an old row): the series that equals the sum of the rest is the total", () => {
    expect(computeHeadline(src({}), rows)).toMatchObject({ value: 66, basis: "total-series" });
  });

  it("totalKey persisted as null (the engine already looked): the headline is not reinterpreted", () => {
    expect(computeHeadline(src({ totalKey: null }), rows)).toMatchObject({ value: 132, basis: "sum-of-series" });
  });

  it("never for a mean, nor for a truncated series list", () => {
    expect(computeHeadline(src({ aggregate: "mean" }), rows)).toBeNull();
    expect(computeHeadline(src({ seriesOverflow: true }), rows)).toBeNull();
  });
});
