import { describe, expect, it } from "vitest";
import { derive, field, years, type Rec } from "./helpers";
import type { VizConfig } from "@/lib/sync/derived";

/** Group F3 regressions r3-03, r3-04, r3-05: means with a published Total, identifier columns, and which column of a wide table is plotted. */

type Multi = Extract<VizConfig, { type: "multi-line" }>;
type Area = Extract<VizConfig, { type: "area" }>;

const GENERIC_SENTENCE = /^تحتوي مجموعة البيانات على /;

// ---------------------------------------------------------------------------
// r3-03: a mean (rate, index) with a published Total uses the Total
// ---------------------------------------------------------------------------
describe("r3-03: the published overall rate beats an unweighted mean of its parts", () => {
  const AGE_GROUPS = ["15-19", "20-24", "25-29", "30-34", "35-39", "40-44", "45-49", "50-54", "55-59", "60-64", "65-69", "70+"];
  const PARTS = [20, 12, 6, 3, 2.5, 2, 1.8, 1.5, 1.6, 2, 3, 4]; // unweighted mean 4.95; the population-weighted rate is 4.4

  function ageTable(opts: { totalYears?: number[]; total?: number } = {}) {
    const records: Rec[] = [];
    for (const y of years(2018, 2024)) {
      for (const [i, g] of AGE_GROUPS.entries()) records.push({ year: String(y), age_group: g, rate: PARTS[i] });
      if (!opts.totalYears || opts.totalYears.includes(y)) records.push({ year: String(y), age_group: "Total", rate: opts.total ?? 4.4 });
    }
    return derive(records, [field("year", "text", "Year"), field("age_group", "text", "Age group"), field("rate", "double", "Unemployment Rate (%)")]);
  }

  it("age groups + 'Total' (reviewer t8): the chart and headline are 4.4, not 4.95", async () => {
    const { viz, rows, summaryAr } = await ageTable();
    const v = viz as Area;
    expect(v.type).toBe("area");
    expect(v.aggregate).toBe("mean");
    expect(rows.every((r) => r.value === 4.4)).toBe(true);
    expect(v.headline?.value).toBe(4.4);
    expect(summaryAr).toBe("آخر قيمة مسجلة: 4.4% في 2024، بتغير 0.0% عن الفترة السابقة.");
    // the caption says the Total was USED: no stale "aggregated across Age group" / "excluded to avoid double counting"
    expect(v.usedTotals).toEqual(["Total"]);
    expect(v.excludedTotals).toBeUndefined();
    expect(v.hiddenDimensions).toBeUndefined();
    expect(v.unweightedMean).toBeUndefined();
  });

  it("sex x nationality with published Total/Total (the skeptic's stronger repro): every series is the published rate", async () => {
    const table: Record<string, Record<string, number>> = {
      Male: { Bahraini: 1.0, "Non-Bahraini": 0.5, Total: 1.2 },
      Female: { Bahraini: 3.0, "Non-Bahraini": 1.0, Total: 2.5 },
      Total: { Bahraini: 5.0, "Non-Bahraini": 0.6, Total: 1.5 },
    };
    const records: Rec[] = [];
    for (const y of years(2019, 2024)) {
      for (const [sex, byNat] of Object.entries(table)) {
        for (const [nat, rate] of Object.entries(byNat)) records.push({ year: String(y), sex, nationality: nat, rate });
      }
    }
    const { viz, rows } = await derive(records, [
      field("year", "text", "Year"),
      field("sex", "text", "Sex"),
      field("nationality", "text", "Nationality"),
      field("rate", "double", "Unemployment Rate (%)"),
    ]);
    const v = viz as Multi;
    expect(v.type).toBe("multi-line");
    expect(v.seriesField).toBe("sex");
    expect(rows[rows.length - 1]).toMatchObject({ Total: 1.5, Male: 1.2, Female: 2.5 });
    expect(v.headline).toMatchObject({ value: 1.5, basis: "total-series" });
    expect(v.usedTotals).toEqual(["Total"]);
  });

  it("Totals published for 2018-22 only: no silent truncation to 2022, the parts are averaged and the headline is withheld", async () => {
    const { viz, rows, summaryAr } = await ageTable({ totalYears: [2018, 2019, 2020, 2021, 2022] });
    const v = viz as Area;
    expect(rows.map((r) => r.period)).toEqual(["2018", "2019", "2020", "2021", "2022", "2023", "2024"]);
    expect(rows[6].value).toBeCloseTo(4.95, 2);
    expect(v.unweightedMean).toBe(true);
    expect(v.excludedTotals).toEqual(["Total"]);
    expect(v.headline).toBeNull();
    expect(v.headlineWithheld).toBe("unweighted-mean");
    expect(summaryAr).toMatch(GENERIC_SENTENCE);
  });

  it("a Total that is simply the sum of its parts (shares adding to 100) is not 'the rate': parts are kept, headline withheld", async () => {
    const records: Rec[] = [];
    for (const y of years(2018, 2024)) {
      for (let i = 0; i < 10; i++) records.push({ year: String(y), sector: `S${i + 1}`, share: 10 });
      records.push({ year: String(y), sector: "Total", share: 100 });
    }
    const { viz, rows } = await derive(records, [field("year", "text", "Year"), field("sector", "text", "Sector"), field("share", "double", "Share (%)")]);
    const v = viz as Area;
    expect(rows.every((r) => r.value === 10)).toBe(true); // not a flat, tautological 100%
    expect(v.usedTotals).toBeUndefined();
    expect(v.excludedTotals).toEqual(["Total"]);
    expect(v.headline).toBeNull();
  });

  it("two hidden total dimensions with only mixed Total combinations: no level mixing, falls back to the parts", async () => {
    const records: Rec[] = [];
    for (const y of years(2018, 2023)) {
      for (const sex of ["Male", "Female", "Total"]) {
        for (const nat of ["Bahraini", "Non-Bahraini"]) records.push({ year: String(y), sex, nationality: nat, rate: sex === "Total" ? 9 : 3 });
      }
      // Total only ever appears on ONE of the two dimensions at a time: there is no (Total, Total) cell
      records.push({ year: String(y), sex: "Male", nationality: "Total", rate: 8 });
      records.push({ year: String(y), sex: "Female", nationality: "Total", rate: 8 });
    }
    const { viz } = await derive(records, [
      field("year", "text", "Year"),
      field("sex", "text", "Sex"),
      field("nationality", "text", "Nationality"),
      field("rate", "double", "Unemployment Rate"),
    ]);
    expect((viz as Multi).usedTotals).toBeUndefined();
  });

  it("sums are unchanged: the hidden Total is dropped and the parts are added", async () => {
    const records: Rec[] = [];
    for (const y of years(2018, 2023)) {
      for (const g of ["A", "B", "C"]) records.push({ year: String(y), grp: g, value: 10 });
      records.push({ year: String(y), grp: "Total", value: 30 });
    }
    const { viz, rows } = await derive(records, [field("year", "text", "Year"), field("grp", "text", "Group"), field("value", "int", "Value")]);
    // `grp` has 4 values, so it is the series: the Total is the plotted total series, nothing is summed with it
    expect((viz as Multi).totalKey).toBe("Total");
    expect(rows[0]).toMatchObject({ Total: 30, A: 10 });
  });
});

// ---------------------------------------------------------------------------
// r3-04: identifier-like numeric columns are not measures
// ---------------------------------------------------------------------------
describe("r3-04: phone / CPR / building / road / block columns are never the measure", () => {
  function directory() {
    const records: Rec[] = [];
    for (let i = 0; i < 200; i++) {
      records.push({
        governorate: ["Capital", "Muharraq", "Northern", "Southern"][i % 4],
        type: ["Public", "Private", "Special"][i % 3],
        phone: 17000000 + i * 37,
        building: 100 + (i % 90),
        road: 1000 + (i % 40),
        block: 300 + (i % 30),
        students: i % 5 === 0 ? null : 200 + (i % 17) * 10,
        lat: 26.1 + i / 1000,
        lon: 50.5 + i / 1000,
      });
    }
    return derive(records, [
      field("governorate", "text", "Governorate"),
      field("type", "text", "Type"),
      field("phone", "int", "Phone"),
      field("building", "int", "Building"),
      field("road", "int", "Road"),
      field("block", "int", "Block"),
      field("students", "int", "Students"),
      field("lat", "double", "Latitude"),
      field("lon", "double", "Longitude"),
    ]);
  }

  it("a 200-school directory plots the students column, not the building numbers", async () => {
    const { viz, statsJson } = await directory();
    expect((viz as { measureField: string }).measureField).toBe("students");
    // the stats panel and the chart now agree about what is an identifier
    for (const f of ["phone", "building", "road", "block"]) expect(statsJson?.[f].looksLikeIdentifier, f).toBe(true);
    expect(statsJson?.students.looksLikeIdentifier).toBeUndefined();
  });

  it.each([
    ["Phone", "phone"],
    ["CPR Number", "cpr_number"],
    ["License Number", "license_number"],
    ["Building No", "building_no"],
    ["رقم الهاتف", "phone_ar"],
  ])("%s alone is no measure: the dataset is a table, not a chart of summed identifiers", async (label, name) => {
    const records: Rec[] = [];
    for (let i = 0; i < 40; i++) records.push({ governorate: ["Capital", "Muharraq", "Northern", "Southern"][i % 4], [name]: 17000000 + i * 13 });
    const { viz, summaryAr } = await derive(records, [field("governorate", "text", "Governorate"), field(name, "int", label)]);
    expect(viz.type).toBe("table");
    expect(summaryAr).toMatch(GENERIC_SENTENCE);
  });

  it.each(["Road Accidents", "Building Permits", "Passengers Number", "Total Number", "Vehicles No", "Road Length (km)", "Zone Population", "Plot Area", "Number of Units", "Cases"])(
    "negative control: %j stays a measure",
    async (label) => {
      const records: Rec[] = [];
      for (let i = 0; i < 40; i++) records.push({ governorate: ["Capital", "Muharraq", "Northern", "Southern"][i % 4], v: 100 + i * 3 });
      const { viz } = await derive(records, [field("governorate", "text", "Governorate"), field("v", "int", label)]);
      expect(viz.type).toBe("bar-h");
    },
  );

  it("a viz override can still pin an identifier-named column", async () => {
    const records: Rec[] = [];
    for (let i = 0; i < 40; i++) records.push({ governorate: ["Capital", "Muharraq", "Northern", "Southern"][i % 4], building: 5 + (i % 7) });
    const { viz } = await derive(records, [field("governorate", "text", "Governorate"), field("building", "int", "Building")], { measureField: "building" });
    expect(viz.type).toBe("bar-h");
  });
});

// ---------------------------------------------------------------------------
// r3-05: which column of a wide table is plotted
// ---------------------------------------------------------------------------
describe("r3-05: the plotted column of a wide table is the Total, not an arbitrary component", () => {
  const measureOf = (viz: unknown) => (viz as { measureField: string }).measureField;

  it.each([1.0, 1.01, 1.03])("year / bahraini / non_bahraini / total at growth %s: total is plotted", async (g) => {
    const records: Rec[] = years(2010, 2024).map((y) => {
      const b = Math.round(1000 * g ** (y - 2010));
      const n = Math.round(1500 * g ** (y - 2010));
      return { year: String(y), bahraini: b, non_bahraini: n, total: b + n };
    });
    const { viz, rows } = await derive(records, [
      field("year", "text", "Year"),
      field("bahraini", "int", "Bahraini"),
      field("non_bahraini", "int", "Non-Bahraini"),
      field("total", "int", "Total"),
    ]);
    expect(measureOf(viz)).toBe("total");
    const last = records[records.length - 1];
    expect(rows[rows.length - 1].value).toBe(last.total);
  });

  it("governorate columns + a 'kingdom' column (no 'total' in the name): the largest additive column wins", async () => {
    const records: Rec[] = years(2012, 2024).map((y) => {
      const k = y - 2012;
      const cols = { capital: 4000 + k * 30, muharraq: 3000 + k * 20, northern: 5000 + k * 40, southern: 2500 + k * 25 };
      return { year: String(y), ...cols, kingdom: Object.values(cols).reduce((a, b) => a + b, 0) };
    });
    const { viz } = await derive(records, [
      field("year", "text", "Year"),
      field("capital", "int", "Capital"),
      field("muharraq", "int", "Muharraq"),
      field("northern", "int", "Northern"),
      field("southern", "int", "Southern"),
      field("kingdom", "int", "Kingdom"),
    ]);
    expect(measureOf(viz)).toBe("kingdom");
  });

  it("two total-named columns are ambiguous: falls through to magnitude, never 'first match'", async () => {
    const records: Rec[] = years(2012, 2024).map((y) => ({ year: String(y), total_imports: 900 + y - 2012, total_exports: 1300 + (y - 2012) * 2, re_exports: 100 + ((y * 5) % 9) }));
    const { viz } = await derive(records, [
      field("year", "text", "Year"),
      field("total_imports", "int", "Total Imports"),
      field("total_exports", "int", "Total Exports"),
      field("re_exports", "int", "Re-exports"),
    ]);
    expect(measureOf(viz)).toBe("total_exports");
  });

  it("an additive column that varies beats a rate column (population vs growth %, the old behaviour)", async () => {
    const records: Rec[] = years(2010, 2024).map((y) => ({ year: String(y), population: 1_200_000 + (y - 2010) * 35_000, growth_pct: 1.5 + ((y * 7) % 10) / 3 }));
    const { viz } = await derive(records, [field("year", "text", "Year"), field("population", "int", "Population"), field("growth_pct", "double", "Growth (%)")]);
    expect(measureOf(viz)).toBe("population");
  });

  it("a nearly flat additive column does NOT beat a rate that actually moves (existing scale-free rule)", async () => {
    const records: Rec[] = years(2010, 2024).map((y) => ({ year: String(y), population: 1_000_000 + (y % 2) * 1000, share: 10 + (y - 2010) * 3 }));
    const { viz } = await derive(records, [field("year", "text", "Year"), field("population", "int", "Population"), field("share", "double", "Share (%)")]);
    expect(measureOf(viz)).toBe("share");
  });

  it("columns in different units are separate groups: the more informative additive column wins", async () => {
    const records: Rec[] = years(2010, 2024).map((y) => ({ year: String(y), visitors: 100_000 + (y - 2010) * 9000, revenue: 5_000_000 + ((y * 13) % 7) * 100 }));
    const { viz } = await derive(records, [
      field("year", "text", "Year"),
      field("visitors", "int", "Visitors (persons)"),
      field("revenue", "int", "Revenue (BHD)"),
    ]);
    expect(measureOf(viz)).toBe("visitors");
  });
});
