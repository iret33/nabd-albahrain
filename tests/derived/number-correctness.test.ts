import { describe, expect, it } from "vitest";
import { derive, field, years, months, type Rec } from "./helpers";
import { extractFeaturedMetric, extractTrendSeries } from "@/lib/chart-data";
import { computeHeadline, headlineSeries, seriesAreHeterogeneous } from "@/lib/headline";
import type { VizConfig } from "@/lib/sync/derived";

/**
 * Table-driven regressions for the number-correctness review (group F3). Each
 * block is a reproduction taken from a confirmed finding plus the negative
 * controls the skeptic asked for ("must still be ...").
 */

type Multi = Extract<VizConfig, { type: "multi-line" }>;
type Area = Extract<VizConfig, { type: "area" }>;

const GENERIC_SENTENCE = /^تحتوي مجموعة البيانات على /;

// ---------------------------------------------------------------------------
// r3-01: heterogeneous series are not summed
// ---------------------------------------------------------------------------
describe("r3-01: a sum of unrelated indicators is never a headline", () => {
  function longTable(
    series: Record<string, (y: number) => number>,
    dim: { name: string; label: string } = { name: "indicator", label: "Indicator" },
  ) {
    const records: Rec[] = [];
    for (const y of years(2015, 2024)) for (const [name, f] of Object.entries(series)) records.push({ year: String(y), [dim.name]: name, value: f(y) });
    return derive(records, [field("year", "text", "Year"), field(dim.name, "text", dim.label), field("value", "double", "Value")]);
  }

  it("rate + persons + labour force (the reviewer's t14 case): headline withheld, generic sentence, reason recorded", async () => {
    const { viz, summaryAr, rows } = await longTable({
      "Unemployment Rate (%)": (y) => 3.6 + (y - 2015) * 0.01,
      "Unemployed Persons": (y) => 22000 + (y - 2015) * 100,
      "Labour Force": (y) => 809000 + (y - 2015) * 1000,
    });
    const v = viz as Multi;
    expect(v.type).toBe("multi-line");
    expect(v.headline).toBeNull();
    expect(v.headlineWithheld).toBe("mixed-series");
    expect(summaryAr).toMatch(GENERIC_SENTENCE);
    // nothing downstream invents a number either: no card metric, no summed sparkline
    expect(extractFeaturedMetric(v, rows)).toBeNull();
    expect(extractTrendSeries(v, rows)).toBeNull();
  });

  it("five pollutants as series (an 'indicator' dimension with plain names): withheld", async () => {
    const { viz, summaryAr } = await longTable(
      { PM10: (y) => 60 + y - 2015, "PM2.5": () => 30, SO2: () => 8, NO2: () => 25, O3: () => 70 },
      { name: "pollutant", label: "Pollutant" },
    );
    const v = viz as Multi;
    expect(v.headline).toBeNull();
    expect(v.headlineWithheld).toBe("mixed-series");
    expect(summaryAr).toMatch(GENERIC_SENTENCE);
  });

  it("a neutral dimension name with magnitudes five orders apart is caught by the backstop", async () => {
    const { viz } = await longTable({ A: () => 3, B: () => 500_000, C: () => 2_000_000 }, { name: "item", label: "Item" });
    expect((viz as Multi).headline).toBeNull();
    expect((viz as Multi).headlineWithheld).toBe("mixed-series");
  });

  const negativeControls: Array<[string, Record<string, (y: number) => number>, { name: string; label: string }]> = [
    ["nationality", { Bahraini: () => 700, "Non-Bahraini": () => 840 }, { name: "nationality", label: "Nationality" }],
    ["governorate", { Capital: () => 400, Muharraq: () => 300, Northern: () => 500, Southern: () => 200 }, { name: "governorate", label: "Governorate" }],
    ["education level (the word 'Level' is a partition here)", { "Primary Level": () => 300, "Secondary Level": () => 250, "Level 1": () => 120 }, { name: "stage", label: "Stage" }],
    ["a skewed partition with a small 'Other'", { Bahraini: () => 700_000, "Non-Bahraini": () => 800_000, Other: () => 900 }, { name: "nationality", label: "Nationality" }],
    ["'Type of School' is not an indicator dimension", { Public: () => 300, Private: () => 120 }, { name: "school_type", label: "Type of School" }],
  ];
  it.each(negativeControls)("negative control (%s) keeps its sum-of-series headline", async (_name, series, dim) => {
    const { viz } = await longTable(series, dim);
    const v = viz as Multi;
    expect(v.headline?.basis).toBe("sum-of-series");
    expect(v.headlineWithheld).toBeUndefined();
  });

  it("the airport 'data_type' series WITH a labeled total stays on the total-series basis", async () => {
    const { viz } = await longTable(
      { "Passengers Total": () => 1000, "Passengers Embark": () => 500, "Passengers Disembark": () => 400, "Passengers Transit": () => 100 },
      { name: "data_type", label: "Data type" },
    );
    expect((viz as Multi).headline?.basis).toBe("total-series");
    expect((viz as Multi).headline?.value).toBe(1000);
  });

  it("every series named as a percentage also refuses (Male (%) + Female (%) sums to 100)", async () => {
    const { viz } = await longTable({ "Male (%)": () => 48, "Female (%)": () => 52 }, { name: "sex", label: "Sex" });
    expect((viz as Multi).headline).toBeNull();
  });

  it("render-time gate for rows synced before the fix: no summed sparkline / trend, no featured metric", () => {
    const cfg = {
      type: "multi-line",
      grain: "year",
      aggregate: "sum",
      seriesField: "indicator",
      seriesLabel: "Indicator",
      seriesValues: ["Unemployed Persons", "Labour Force"],
      seriesOverflow: false,
    } as unknown as VizConfig;
    const rows = [
      { period: "2023", "Unemployed Persons": 22000, "Labour Force": 809000 },
      { period: "2024", "Unemployed Persons": 22100, "Labour Force": 810000 },
    ];
    expect(extractTrendSeries(cfg, rows)).toBeNull();
    expect(extractFeaturedMetric(cfg, rows)).toBeNull();
    expect(headlineSeries(cfg as never, rows)).toBeNull();
    expect(seriesAreHeterogeneous(cfg as never, rows)).toBe(true);
    // the same rows with partition-like names keep working
    const ok = { ...(cfg as unknown as Record<string, unknown>), seriesField: "nationality", seriesLabel: "Nationality", seriesValues: ["Bahraini", "Non-Bahraini"] } as unknown as VizConfig;
    expect(
      computeHeadline(ok as never, [
        { period: "2023", Bahraini: 20, "Non-Bahraini": 30 },
        { period: "2024", Bahraini: 25, "Non-Bahraini": 30 },
      ])?.value,
    ).toBe(55);
  });
});

// ---------------------------------------------------------------------------
// r3-02: totals recognised by label tiers AND by arithmetic
// ---------------------------------------------------------------------------
describe("r3-02: a total the labels miss is found by arithmetic, never by label alone", () => {
  /** Series = Sex (Male/Female) x hidden Nationality (Bahraini/Non-Bahraini + a total row labelled `label`). */
  async function hiddenTotal(label: string, opts: { honest?: boolean } = {}) {
    const records: Rec[] = [];
    for (const y of years(2018, 2023)) {
      for (const sex of ["Male", "Female"]) {
        const bah = 100 + (y - 2018) * 5;
        const non = 100 + (y - 2018) * 3;
        records.push({ year: String(y), sex, nationality: "Bahraini", value: bah });
        records.push({ year: String(y), sex, nationality: "Non-Bahraini", value: non });
        records.push({ year: String(y), sex, nationality: label, value: opts.honest === false ? bah + non + 7 : bah + non });
      }
    }
    return derive(records, [field("year", "text", "Year"), field("sex", "text", "Sex"), field("nationality", "text", "Nationality"), field("value", "int", "Value")]);
  }

  it.each(["Total (all)", "Total Population", "All", "All nationalities", "Total, all", "Total-all", "Both", "جميع الجنسيات"])(
    "hidden dimension: %j that equals the sum of its siblings is dropped (headline is the parts, not 2x)",
    async (label) => {
      const { viz, rows } = await hiddenTotal(label);
      const v = viz as Multi;
      // Male = 2023: bah 125 + non 115 = 240 (not 480)
      expect(rows[rows.length - 1]).toMatchObject({ period: "2023", Male: 240, Female: 240 });
      expect(v.excludedTotals).toEqual([label]);
      expect(v.headline?.value).toBe(480);
    },
  );

  it("a candidate label whose numbers do NOT add up is a legitimate part and is kept", async () => {
    const { viz, rows } = await hiddenTotal("All", { honest: false });
    expect((viz as Multi).excludedTotals).toBeUndefined();
    expect(rows[rows.length - 1].Male).toBe(240 + 247);
  });

  it("'Bahrain' as a real nationality (not the sum of the others) is kept", async () => {
    const records: Rec[] = [];
    for (const y of years(2018, 2023)) {
      for (const sex of ["Male", "Female"]) for (const nat of ["Bahrain", "India", "Egypt"]) records.push({ year: String(y), sex, nationality: nat, value: 50 });
    }
    const { viz, rows } = await derive(records, [field("year", "text", "Year"), field("sex", "text", "Sex"), field("nationality", "text", "Nationality"), field("value", "int", "Value")]);
    expect((viz as Multi).excludedTotals).toBeUndefined();
    expect(rows[0]).toMatchObject({ Male: 150 });
  });

  async function governorates(national: string) {
    const records: Rec[] = [];
    for (const y of years(2016, 2023)) {
      const parts = { Capital: 400 + y - 2016, Muharraq: 300, Northern: 500, Southern: 200 + (y - 2016) * 2 };
      for (const [g, v] of Object.entries(parts)) records.push({ year: String(y), governorate: g, value: v });
      records.push({ year: String(y), governorate: national, value: Object.values(parts).reduce((a, b) => a + b, 0) });
    }
    return derive(records, [field("year", "text", "Year"), field("governorate", "text", "Governorate"), field("value", "int", "Value")]);
  }

  it.each(["Kingdom of Bahrain", "Kingdom", "Bahrain", "المملكة", "مملكة البحرين"])("multi-line: %j (a national row) becomes the total series, headline is the national figure", async (national) => {
    const { viz } = await governorates(national);
    const v = viz as Multi;
    expect(v.type).toBe("multi-line");
    expect(v.totalKey).toBe(national);
    expect(v.seriesValues[0]).toBe(national);
    expect(v.headline?.basis).toBe("total-series");
    // 2023: 407 + 300 + 500 + 214 = 1421, NOT 2842
    expect(v.headline?.value).toBe(1421);
  });

  it("bar-h: a national row among the categories is not the top category", async () => {
    const records: Rec[] = [
      { governorate: "Capital", value: 400 },
      { governorate: "Muharraq", value: 300 },
      { governorate: "Northern", value: 500 },
      { governorate: "Southern", value: 200 },
      { governorate: "Kingdom of Bahrain", value: 1400 },
    ];
    const { viz, rows, summaryAr } = await derive(records, [field("governorate", "text", "Governorate"), field("value", "int", "Value")]);
    expect(viz.type).toBe("bar-h");
    expect(rows.map((r) => r.category)).not.toContain("Kingdom of Bahrain");
    expect((viz as { excludedTotals?: string[] }).excludedTotals).toEqual(["Kingdom of Bahrain"]);
    expect(summaryAr).toContain("«Northern» بقيمة 500");
  });

  it("bar-h: a nominated label that is NOT the sum of the others stays a category", async () => {
    const records: Rec[] = [
      { region: "Capital", value: 400 },
      { region: "Muharraq", value: 300 },
      { region: "Bahrain", value: 900 },
    ];
    const { rows } = await derive(records, [field("region", "text", "Region"), field("value", "int", "Value")]);
    expect(rows.map((r) => r.category)).toContain("Bahrain");
  });

  it.each([5, 8, 9, 10, 14])("airport pattern with %i distinct data_type values: 'Passengers Total' is never double counted", async (n) => {
    const parts = Array.from({ length: n - 1 }, (_, i) => `Part ${i + 1}`);
    const records: Rec[] = [];
    for (const [i, ym] of months(2024, 2025).entries()) {
      let total = 0;
      for (const p of parts) {
        const v = 100 + i;
        total += v;
        records.push({ month: `${ym}-01`, data_type: p, value: v });
      }
      records.push({ month: `${ym}-01`, data_type: "Passengers Total", value: total });
    }
    const { viz, rows } = await derive(records, [field("month", "date", "Month"), field("data_type", "text", "Data type"), field("value", "double", "Value")]);
    const last = months(2024, 2025).length - 1;
    const expectedTotal = (n - 1) * (100 + last);
    const headline = (viz as Multi | Area).headline;
    expect(headline?.value).toBe(expectedTotal);
    if (viz.type === "area") expect(rows[rows.length - 1].value).toBe(expectedTotal);
  });

  it("a mean measure never goes through the sum check", async () => {
    const records: Rec[] = [];
    for (const y of years(2018, 2023)) {
      for (const g of ["A", "B"]) records.push({ year: String(y), group: g, region: "R1", rate: 10 });
      records.push({ year: String(y), group: "All", region: "R1", rate: 20 });
    }
    const { viz } = await derive(records, [field("year", "text", "Year"), field("group", "text", "Group"), field("region", "text", "Region"), field("rate", "double", "Unemployment Rate")]);
    expect((viz as Multi).excludedTotals).toBeUndefined();
  });
});
