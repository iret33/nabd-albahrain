import { describe, expect, it } from "vitest";
import { derive, field, years, type Rec } from "./helpers";
import { chartCaptionParts } from "@/lib/chart-data";
import { DERIVED_VERSION, computeDerivedFields, type VizConfig } from "@/lib/sync/derived";

/** Group F3 regressions r3-09 (the "أخرى" bucket), r3-13 (reserved keys), R5-04 (Arabic counts), r3-11 (version). */

type Multi = Extract<VizConfig, { type: "multi-line" }>;
type BarH = Extract<VizConfig, { type: "bar-h" }>;
type Stacked = Extract<VizConfig, { type: "bar-stacked" }>;

// ---------------------------------------------------------------------------
// r3-09
// ---------------------------------------------------------------------------
describe("r3-09: a real category called 'أخرى' never collides with the synthetic rest bucket", () => {
  const OTHER = "أخرى";

  /** 19 ordinary categories (100..118) plus `real` rows for a category literally named أخرى. */
  const barRecords = (otherValue: number, count = 19): Rec[] => [
    ...Array.from({ length: count }, (_, i) => ({ cat: `N${String(i + 1).padStart(2, "0")}`, value: 100 + i })),
    { cat: OTHER, value: otherValue },
  ];
  const barFields = [field("cat", "text", "Cat"), field("value", "int", "Value")];

  it("bar-h: the real top 'أخرى' keeps its bar and the bucket gets a distinct label", async () => {
    const { viz, rows, summaryAr } = await derive(barRecords(10_000), barFields);
    const v = viz as BarH;
    expect(v.otherBucketed).toBe(true);
    expect(v.otherLabel).toBe("أخرى (البقية)");
    expect(rows[0]).toEqual({ category: OTHER, value: 10_000 });
    expect(rows[rows.length - 1].category).toBe("أخرى (البقية)");
    const labels = rows.map((r) => r.category);
    expect(new Set(labels).size).toBe(labels.length);
    // the summary names the TRUE top category and quotes the 20 categories with correct agreement
    expect(summaryAr).toBe("الفئة الأعلى: «أخرى» بقيمة 10,000 من أصل 20 فئةً.");
    expect(chartCaptionParts(v).notes).toContain("تُعرض أعلى الفئات وتُجمع البقية ضمن «أخرى (البقية)»");
  });

  it("bar-h without any bucket: a real top 'أخرى' is quoted (it was skipped, naming a smaller category)", async () => {
    const { summaryAr } = await derive(
      [
        { cat: "Bahraini", value: 600 },
        { cat: "Saudi", value: 200 },
        { cat: OTHER, value: 10_000 },
        { cat: "Indian", value: 300 },
      ],
      barFields,
    );
    expect(summaryAr).toBe("الفئة الأعلى: «أخرى» بقيمة 10,000 من أصل 4 فئات.");
  });

  it("bar-h: a real 'أخرى' that falls INTO the rest is folded into the bucket, which keeps the default label", async () => {
    const { viz, rows } = await derive(barRecords(1), barFields);
    const v = viz as BarH;
    expect(v.otherLabel).toBeUndefined();
    expect(rows[rows.length - 1]).toEqual({ category: OTHER, value: 100 + 101 + 102 + 103 + 1 });
    expect(rows.filter((r) => r.category === OTHER)).toHaveLength(1);
  });

  it("bar-h with no real 'أخرى': unchanged (default label, no otherLabel field)", async () => {
    const { viz, rows } = await derive(barRecords(5).filter((r) => r.cat !== OTHER).concat([{ cat: "N20", value: 99 }]), barFields);
    expect((viz as BarH).otherLabel).toBeUndefined();
    expect(rows[rows.length - 1].category).toBe(OTHER);
  });

  it("bar-stacked: a real 'أخرى' series among > 8 series keeps its own values; the bucket series is a separate, uniquely named key", async () => {
    const recs: Rec[] = [];
    for (let x = 1; x <= 14; x++) {
      recs.push({ s: OTHER, x: `X${String(x).padStart(2, "0")}`, value: 1000 });
      for (let s = 1; s <= 9; s++) recs.push({ s: `S${s}`, x: `X${String(x).padStart(2, "0")}`, value: s });
    }
    const { viz, rows, summaryAr } = await derive(recs, [field("s", "text", "S"), field("x", "text", "X"), field("value", "int", "Value")]);
    const v = viz as Stacked;
    expect(v.seriesField).toBe("s");
    expect(v.seriesOverflow).toBe(true);
    expect(v.otherSeriesBucketed).toBe(true);
    expect(v.otherLabel).toBe("أخرى (البقية)");
    expect(new Set(v.seriesValues).size).toBe(v.seriesValues.length);
    expect(v.seriesValues).toContain(OTHER);
    expect(v.seriesValues[v.seriesValues.length - 1]).toBe("أخرى (البقية)");
    const row = rows.find((r) => r.category === "X01")!;
    expect(row[OTHER]).toBe(1000); // the real series is NOT replaced by the folded ones
    expect(row["أخرى (البقية)"]).toBe(1 + 2 + 3); // S1..S3 folded
    // the stack the summary quotes counts every series exactly once
    expect(summaryAr).toBe("الفئة الأعلى: «X01» بقيمة 1,045.");
  });

  it("bar-stacked: a real 'أخرى' x-category with more than 15 x values gets a distinct rest row", async () => {
    const recs: Rec[] = [];
    for (let x = 1; x <= 17; x++) for (const s of ["P", "Q"]) recs.push({ s, x: `X${String(x).padStart(2, "0")}`, value: x });
    for (const s of ["P", "Q"]) recs.push({ s, x: OTHER, value: 500 });
    const { viz, rows } = await derive(recs, [field("s", "text", "S"), field("x", "text", "X"), field("value", "int", "Value")]);
    const v = viz as Stacked;
    expect(v.otherBucketed).toBe(true);
    expect(v.otherLabel).toBe("أخرى (البقية)");
    const labels = rows.map((r) => r.category);
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels[0]).toBe(OTHER);
    expect(labels[labels.length - 1]).toBe("أخرى (البقية)");
  });

  it("old rows carry no otherLabel: the caption keeps the default", () => {
    const old = {
      type: "bar-h",
      geoFields: [],
      dimensionField: "c",
      dimensionLabel: "C",
      measureField: "v",
      measureLabel: "V",
      aggregate: "sum",
      categoryCount: 20,
      otherBucketed: true,
    } as unknown as VizConfig;
    expect(chartCaptionParts(old).notes).toContain("تُعرض أعلى الفئات وتُجمع البقية ضمن «أخرى»");
  });
});

// ---------------------------------------------------------------------------
// r3-13
// ---------------------------------------------------------------------------
describe("r3-13: values and field names that look like reserved keys do not corrupt rows or stats", () => {
  const longRows = (series: string[], fieldNames = { grp: "grp", value: "value" }): Rec[] => {
    const out: Rec[] = [];
    for (const y of years(2015, 2019)) {
      for (const [i, s] of series.entries()) out.push(JSON.parse(JSON.stringify({ year: String(y), [fieldNames.grp]: s, [fieldNames.value]: 5 + i })));
    }
    return out;
  };
  const longFields = [field("year", "text", "Year"), field("grp", "text", "Group"), field("value", "int", "Value")];

  it("a series called 'period' no longer overwrites the x value", async () => {
    const { viz, rows } = await derive(longRows(["period", "other", "x"]), longFields);
    const v = viz as Multi;
    expect(v.seriesKeyEscapes).toEqual([{ from: "period", to: "«period»" }]);
    expect(v.seriesValues).toContain("«period»");
    expect(v.seriesValues).not.toContain("period");
    for (const r of rows) {
      expect(typeof r.period).toBe("string");
      expect(r["«period»"]).toBe(5);
    }
    expect(v.headline).not.toBeNull();
    expect(chartCaptionParts(v).notes).toContain("أُعيدت تسمية بعض السلاسل لأن أسماءها محجوزة للرسم");
  });

  it("a series called '__proto__' (own key via JSON.parse) is present in every row and pollutes nothing", async () => {
    const before = Object.getOwnPropertyNames(Object.prototype).sort();
    const { viz, rows } = await derive(longRows(["__proto__", "b", "c"]), longFields);
    const v = viz as Multi;
    expect(v.seriesValues).toContain("«__proto__»");
    for (const r of rows) expect(Object.prototype.hasOwnProperty.call(r, "«__proto__»")).toBe(true);
    expect(Object.getOwnPropertyNames(Object.prototype).sort()).toEqual(before);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("a series ending in '__partial' would collide with the chart's partial-period twin key: renamed", async () => {
    const { viz } = await derive(longRows(["a__partial", "a", "b"]), longFields);
    const v = viz as Multi;
    expect(v.seriesKeyEscapes?.map((e) => e.from)).toEqual(["a__partial"]);
  });

  it("'constructor', 'toString' and 'value' are fine as series keys and are NOT renamed", async () => {
    const { viz, rows } = await derive(longRows(["constructor", "toString", "value"]), longFields);
    const v = viz as Multi;
    expect(v.seriesKeyEscapes).toBeUndefined();
    expect(rows[0]).toMatchObject({ constructor: 5, toString: 6, value: 7 });
    expect(Object.keys(rows[0]).sort()).toEqual(["constructor", "period", "toString", "value"]);
  });

  it("bar-stacked: a series called 'category' no longer overwrites the row label", async () => {
    const recs: Rec[] = [];
    for (const x of ["X1", "X2", "X3", "X4", "X5", "X6"]) for (const s of ["category", "p", "q"]) recs.push({ s, x, value: 7 });
    const { viz, rows } = await derive(recs, [field("s", "text", "S"), field("x", "text", "X"), field("value", "int", "Value")]);
    const v = viz as Stacked;
    expect(v.seriesField).toBe("s");
    expect(v.seriesKeyEscapes).toEqual([{ from: "category", to: "«category»" }]);
    for (const r of rows) {
      expect(typeof r.category).toBe("string");
      expect(r["«category»"]).toBe(7);
    }
  });

  it("a field named '__proto__' keeps its stats (it used to set the prototype of the stats object and vanish)", async () => {
    const recs = years(2015, 2019).map((y) => JSON.parse(JSON.stringify({ year: String(y), v: y, ["__proto__"]: "x" })) as Rec);
    const { statsJson } = await derive(recs, [field("year", "text", "Year"), field("v", "int", "V"), field("__proto__", "text", "Proto")]);
    expect(Object.keys(statsJson!)).toEqual(["year", "v", "__proto__"]);
    const roundTrip = JSON.parse(JSON.stringify(statsJson)) as Record<string, { name: string }>;
    expect(Object.keys(roundTrip)).toContain("__proto__");
    expect(roundTrip["__proto__"].name).toBe("__proto__");
  });

  it.each(["constructor", "toString", "valueOf", "hasOwnProperty"])("a field named %j that is missing from rows reads as null, not as Object.prototype's function", async (name) => {
    const recs: Rec[] = years(2015, 2024).map((y) => ({ year: String(y), v: y }));
    const { statsJson, viz } = await derive(recs, [field("year", "text", "Year"), field("v", "int", "V"), field(name, "text", name)]);
    expect(statsJson![name].nullRate).toBe(1);
    expect(statsJson![name].distinctCount).toBe(0);
    expect(statsJson![name].topValues).toBeUndefined();
    expect(viz.type).toBe("area");
  });

  it("a dimension named 'constructor' with real values charts normally", async () => {
    const recs: Rec[] = [];
    for (const y of years(2015, 2019)) for (const c of ["a", "b"]) recs.push({ year: String(y), constructor: c, value: 3 });
    const { viz, rows } = await derive(recs, [field("year", "text", "Year"), field("constructor", "text", "C"), field("value", "int", "Value")]);
    expect((viz as Multi).seriesField).toBe("constructor");
    expect(rows[0]).toMatchObject({ a: 3, b: 3 });
  });
});

// ---------------------------------------------------------------------------
// R5-04
// ---------------------------------------------------------------------------
describe("R5-04: generated sentences agree in number and group their digits", () => {
  async function fallback(rowCount: number, fieldCount: number) {
    const names = Array.from({ length: fieldCount }, (_, i) => `f${i}`);
    // text fields with a distinct value per row: no dimension, no measure, no chart: the generic sentence
    const recs: Rec[] = Array.from({ length: rowCount }, (_, i) => Object.fromEntries(names.map((n) => [n, `${n}-${i}`])));
    return (await derive(recs, names.map((n) => field(n, "text", n)))).summaryAr;
  }

  it.each([
    [0, 2, "لا تحتوي مجموعة البيانات على أي سجلات."],
    [1, 2, "تحتوي مجموعة البيانات على سجل واحد عبر حقلين."],
    [2, 3, "تحتوي مجموعة البيانات على سجلين عبر 3 حقول."],
    [3, 1, "تحتوي مجموعة البيانات على 3 سجلات عبر حقل واحد."],
    [8, 2, "تحتوي مجموعة البيانات على 8 سجلات عبر حقلين."],
    [10, 10, "تحتوي مجموعة البيانات على 10 سجلات عبر 10 حقول."],
    [11, 11, "تحتوي مجموعة البيانات على 11 سجلًا عبر 11 حقلًا."],
    [60, 3, "تحتوي مجموعة البيانات على 60 سجلًا عبر 3 حقول."],
    [400, 2, "تحتوي مجموعة البيانات على 400 سجلًا عبر حقلين."],
  ])("%i records x %i fields", async (rowCount, fieldCount, expected) => {
    expect(await fallback(rowCount, fieldCount)).toBe(expected);
  });

  it("100,000 records: digits are grouped (they were printed as 100000)", async () => {
    const out = await computeDerivedFields("t", Array.from({ length: 100_000 }, (_, i) => ({ a: `a${i}`, b: `b${i}`, c: `c${i}` })), ["a", "b", "c"].map((n) => field(n, "text", n)), { override: null });
    expect(out.summaryAr).toBe("تحتوي مجموعة البيانات على 100,000 سجلًا عبر 3 حقول.");
  });

  it("no fields at all: no 'عبر 0 حقول'", async () => {
    expect((await derive([{ a: 1 }, { a: 2 }], [])).summaryAr).toBe("تحتوي مجموعة البيانات على سجلين.");
    expect((await derive([], [])).summaryAr).toBe("لا تحتوي مجموعة البيانات على أي سجلات.");
  });

  it.each([
    [2, "من أصل فئتين"],
    [3, "من أصل 3 فئات"],
    [10, "من أصل 10 فئات"],
    [11, "من أصل 11 فئةً"],
    [12, "من أصل 12 فئةً"],
  ])("bar summary with %i categories says %s", async (n, phrase) => {
    const recs: Rec[] = Array.from({ length: n }, (_, i) => ({ c: `C${i + 1}`, value: 10 + i }));
    const { summaryAr, viz } = await derive(recs, [field("c", "text", "C"), field("value", "int", "Value")]);
    expect(viz.type).toBe("bar-h");
    expect(summaryAr).toBe(`الفئة الأعلى: «C${n}» بقيمة ${10 + n - 1} ${phrase}.`);
  });

  it("a single remaining category (after a Total is left out) reads 'فئة واحدة'", async () => {
    const { summaryAr } = await derive([{ c: "Total", value: 10 }, { c: "A", value: 10 }], [field("c", "text", "C"), field("value", "int", "Value")]);
    expect(summaryAr).toBe("الفئة الأعلى: «A» بقيمة 10 من أصل فئة واحدة.");
  });

  it("the old wording ('قاعدة البيانات', 'سجلاً', 'حقلاً', '4 فئة') is gone", async () => {
    const a = await fallback(8, 2);
    expect(a).not.toMatch(/قاعدة البيانات|سجلاً|حقلاً/);
  });
});

describe("r3-11: the derivation version", () => {
  it("is 3: databases stamped 2 (by this branch or any earlier build) are re-derived", () => {
    expect(DERIVED_VERSION).toBe(3);
  });
});
