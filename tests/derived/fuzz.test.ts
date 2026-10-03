import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computeDerivedFields, type VizConfig } from "@/lib/sync/derived";
import { computeHeadline, formatPeriodAr, formatSummaryNumber } from "@/lib/headline";
import { extractFeaturedMetric } from "@/lib/chart-data";
import type { CatalogField } from "@/lib/sync/schemas";

/**
 * Seeded adversarial fuzz of computeDerivedFields. The generator mixes the
 * shapes that broke things in review (provisional years, "Total" and "All"
 * rows, reserved names, a real "أخرى", identifier columns, junk cells, huge and
 * non-finite numbers, bilingual twins, duplicate and blank field names) and
 * asserts invariants that must hold for ANY input:
 *   - never throws, and never reaches the catch-all (it logs console.error);
 *   - the output is JSON-clean: no NaN/Infinity anywhere, Object.prototype untouched;
 *   - deterministic, and identical for a JSON round trip of the records (which is
 *     exactly what `--recompute` feeds it from the database);
 *   - headline == last charted period == the number and period in the sentence;
 *   - bar summaries quote a charted category with its charted value;
 *   - rows carry every series key as an own property, series keys are unique.
 */

function rng(seed: number) {
  let s = (Math.imul(seed, 2654435761) + 12345) >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

type Rec = Record<string, unknown>;
interface Case {
  records: Rec[];
  fields: CatalogField[];
  jsonSafe: boolean;
}

const pick = <T,>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
const f = (name: string, type: string, label?: string) => ({ name, type, label: label ?? name }) as CatalogField;

function generate(seed: number): Case {
  const r = rng(seed);
  const rows = pick(r, [0, 1, 2, 5, 12, 40, 80]);
  const fields: CatalogField[] = [];
  let jsonSafe = true;

  // time axis
  const timeKind = pick(r, ["year-text", "year-int", "date", "month-name", "none", "junk", "provisional"] as const);
  const years = [2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024];
  const timeLabel = (i: number): unknown => {
    const y = years[i % years.length];
    switch (timeKind) {
      case "year-text": return String(y);
      case "year-int": return y;
      case "date": return `${y}-${String((i % 12) + 1).padStart(2, "0")}-${String((i % 28) + 1).padStart(2, "0")}`;
      case "month-name": return `${["Jan", "Feb", "Mar", "Apr", "May", "Jun"][i % 6]} ${y}`;
      case "provisional": return i % years.length === years.length - 1 ? `${y}*` : String(y);
      case "junk": return pick(r, ["n/a", "", null, "????", ".".repeat(300), "2020-13-45", String(y)]);
      default: return undefined;
    }
  };
  if (timeKind !== "none") fields.push(f("year", timeKind === "year-int" ? "int" : timeKind === "date" ? "date" : "text", pick(r, ["Year", "Date", "التاريخ"])));

  // dimensions
  const dimCount = pick(r, [0, 1, 1, 2, 3]);
  const dims: Array<{ name: string; values: string[] }> = [];
  const dimNames = ["nationality", "sex", "region", "type", "period", "category", "constructor", "__proto__", "x__partial"];
  const dimValueSets: string[][] = [
    ["Bahraini", "Non-Bahraini"],
    ["Bahraini", "Non-Bahraini", "Total"],
    ["Male", "Female", "Total (all)"],
    ["Capital", "Muharraq", "Northern", "Southern", "Kingdom of Bahrain"],
    ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K"],
    ["أخرى", "X", "Y"],
    ["period", "category", "__proto__", "constructor", "toString"],
    ["All", "P", "Q", "R"],
    Array.from({ length: 22 }, (_, i) => `Item ${i}`),
  ];
  for (let d = 0; d < dimCount; d++) {
    const name = pick(r, dimNames);
    if (dims.some((x) => x.name === name)) continue;
    dims.push({ name, values: pick(r, dimValueSets) });
    fields.push(f(name, "text", pick(r, [name, name.toUpperCase(), "المؤشر", "Indicator", "Type of School"])));
  }

  // measures
  const measureCount = pick(r, [0, 1, 1, 2, 3]);
  const measures: Array<{ name: string; kind: string }> = [];
  const measureSpecs: Array<[string, string, string]> = [
    ["value", "double", "Value"],
    ["rate", "double", "Unemployment Rate (%)"],
    ["total", "int", "Total"],
    ["phone", "int", "Phone"],
    ["building", "int", "Building"],
    ["students", "int", "Students per teacher"],
    ["n", "int", "N"],
    ["count", "int", "Number of Level 3 schools"],
  ];
  for (let m = 0; m < measureCount; m++) {
    const [name, type, label] = pick(r, measureSpecs);
    if (measures.some((x) => x.name === name)) continue;
    measures.push({ name, kind: type });
    fields.push(f(name, type, label));
  }

  // noise fields: duplicates, blanks, unknown types, geo
  if (r() < 0.2) fields.push(f("value", "double", "Dup"));
  if (r() < 0.1) fields.push({ name: "", type: "text", label: "" } as CatalogField);
  if (r() < 0.1) fields.push(f("weird", "unknown_type"));
  if (r() < 0.15) fields.push(f("geo", "geo_point_2d", "Location"));
  if (r() < 0.1) fields.push(f("toString", "text", "toString"));

  const records: Rec[] = [];
  for (let i = 0; i < rows; i++) {
    const rec: Rec = {};
    const t = timeLabel(i);
    if (t !== undefined) rec.year = t;
    for (const d of dims) rec[d.name] = r() < 0.05 ? null : d.values[(i + Math.floor(i / d.values.length)) % d.values.length];
    for (const m of measures) {
      const roll = r();
      let v: unknown = Math.round(r() * 1000) / (m.kind === "int" ? 1 : 10);
      if (m.kind === "int") v = Math.round(r() * 1000);
      if (m.name === "phone") v = 17000000 + i;
      if (roll < 0.05) v = null;
      else if (roll < 0.07) v = "abc";
      else if (roll < 0.08) { v = Number.NaN; jsonSafe = false; }
      else if (roll < 0.09) { v = Infinity; jsonSafe = false; }
      else if (roll < 0.1) v = -50;
      else if (roll < 0.11) v = 1e18;
      else if (roll < 0.12) v = String(v);
      rec[m.name] = v;
    }
    if (r() < 0.05) rec.extra = { nested: [1, 2, 3] };
    if (r() < 0.02) rec[`k${i}`] = "x".repeat(2000);
    records.push(rec);
  }
  return { records, fields, jsonSafe };
}

/** Every number in `value` is finite. */
function assertFinite(value: unknown, path: string): void {
  if (typeof value === "number") {
    expect(Number.isFinite(value), path).toBe(true);
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => assertFinite(v, `${path}[${i}]`));
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) assertFinite(v, `${path}.${k}`);
  }
}

const protoNames = () => Object.getOwnPropertyNames(Object.prototype).sort().join(",");

// FUZZ_SEEDS=5000 pnpm exec vitest run tests/derived/fuzz.test.ts  explores further than the default 300.
const SEEDS = Number(process.env.FUZZ_SEEDS ?? 300);

describe(`fuzz: computeDerivedFields invariants over ${SEEDS} seeded adversarial tables`, () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  for (let seed = 1; seed <= SEEDS; seed++) {
    it(`seed ${seed}`, async () => {
      const { records, fields, jsonSafe } = generate(seed);
      const before = protoNames();
      const out = await computeDerivedFields("fuzz", records, fields, { override: null });

      // never reached the swallow-everything catch-all
      expect(errorSpy, `console.error: ${String(errorSpy.mock.calls[0]?.[1] ?? errorSpy.mock.calls[0]?.[0])}`).not.toHaveBeenCalled();
      expect(out.summaryAr).toBeTruthy();
      expect(protoNames()).toBe(before);
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();

      assertFinite(out.chartData, "chartData");
      assertFinite(out.vizConfig, "vizConfig");
      assertFinite(out.statsJson, "statsJson");

      // deterministic
      const again = await computeDerivedFields("fuzz", records, fields, { override: null });
      expect(JSON.stringify(again)).toBe(JSON.stringify(out));
      // identical for what the database hands back to --recompute
      if (jsonSafe) {
        const roundTrip = await computeDerivedFields("fuzz", JSON.parse(JSON.stringify(records)) as Rec[], fields, { override: null });
        expect(JSON.stringify(roundTrip)).toBe(JSON.stringify(out));
      }
      // persistable as JSON and back
      expect(() => JSON.parse(JSON.stringify(out))).not.toThrow();

      const viz = out.vizConfig as VizConfig | null;
      const rows = (out.chartData ?? []) as Array<Record<string, unknown>>;
      if (!viz || viz.type === "table" || !out.chartData) return;

      if (viz.type === "area" || viz.type === "multi-line") {
        expect(rows.length).toBeLessThanOrEqual(500);
        const periods = rows.map((x) => x.period as string);
        expect(periods).toEqual([...periods].sort());
        expect(new Set(periods).size).toBe(periods.length);
        if (viz.type === "multi-line") {
          expect(new Set(viz.seriesValues).size).toBe(viz.seriesValues.length);
          for (const row of rows) for (const k of viz.seriesValues) expect(Object.prototype.hasOwnProperty.call(row, k), k).toBe(true);
          expect(viz.seriesValues.length).toBeLessThanOrEqual(30);
          if (viz.totalKey) expect(viz.seriesValues[0]).toBe(viz.totalKey);
        }
        if (viz.headline) {
          expect(periods).toContain(viz.headline.period);
          expect(out.summaryAr).toContain(formatSummaryNumber(viz.headline.value));
          expect(out.summaryAr).toContain(formatPeriodAr(viz.headline.period));
          // the persisted headline is what the render layer recomputes from the charted rows (the headline is the
          // last USABLE period: a trailing gap or a series missing from the last period moves it back, by design)
          const { provisional, ...persisted } = viz.headline;
          void provisional;
          expect(computeHeadline(viz, rows)).toEqual(persisted);
          const metric = extractFeaturedMetric(viz, rows);
          expect(metric?.value).toBe(viz.headline.value);
        } else {
          expect(out.summaryAr).toMatch(/^(?:لا )?تحتوي مجموعة البيانات/);
          expect(extractFeaturedMetric(viz, rows)).toBeNull();
          // withheld on purpose: say why, except when the chart simply has no usable number
          if (viz.headlineWithheld) expect(["ambiguous-total", "mean-series", "mixed-series", "overflow", "unweighted-mean"]).toContain(viz.headlineWithheld);
        }
      } else if (viz.type === "bar-h" || viz.type === "bar-stacked") {
        expect(rows.length).toBeLessThanOrEqual(16);
        const labels = rows.map((x) => x.category as string);
        expect(new Set(labels).size).toBe(labels.length);
        const quoted = /«(.+)»/.exec(out.summaryAr ?? "");
        if (quoted) {
          const row = rows.find((x) => x.category === quoted[1]);
          expect(row, `${quoted[1]} is a charted category`).toBeDefined();
          if (viz.type === "bar-h") expect(out.summaryAr).toContain(formatSummaryNumber(row!.value as number));
        }
        if (viz.type === "bar-stacked") {
          expect(new Set(viz.seriesValues).size).toBe(viz.seriesValues.length);
          for (const row of rows) for (const k of viz.seriesValues) expect(Object.prototype.hasOwnProperty.call(row, k), k).toBe(true);
        }
      } else if (viz.type === "histogram") {
        expect(rows.reduce((a, x) => a + (x.count as number), 0)).toBeGreaterThan(0);
        expect(new Set(rows.map((x) => x.bucket)).size).toBe(rows.length);
      }
    });
  }

  it("the generator reaches every chart type (the invariants are not vacuous)", async () => {
    const seen = new Set<string>();
    for (let seed = 1; seed <= SEEDS; seed++) {
      const { records, fields } = generate(seed);
      const out = await computeDerivedFields("fuzz", records, fields, { override: null });
      seen.add((out.vizConfig as VizConfig | null)?.type ?? "null");
    }
    for (const t of ["area", "multi-line", "bar-h", "bar-stacked", "table"]) expect(seen.has(t), t).toBe(true);
  });
});
