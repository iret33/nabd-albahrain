import { describe, expect, it } from "vitest";
import { derive, field, type Rec } from "./helpers";
import { extractFeaturedMetric } from "@/lib/chart-data";
import { formatSummaryNumber } from "@/lib/headline";
import type { VizConfig } from "@/lib/sync/derived";

/**
 * Property-style consistency check over 120 seeded random datasets: the chart
 * cells equal an independent oracle computed straight from the generator, and
 * the three places a headline number appears (persisted vizConfig.headline,
 * the card/home metric from extractFeaturedMetric, the summary sentence) are
 * ONE number. This is the regression net for "card says 1.5M, page says 4.7M".
 */

function rng(seed: number) {
  let s = (seed * 2654435761) >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

interface Spec {
  /** No series column at all: a single measure summed over hidden dimensions (area chart). */
  areaMode: boolean;
  grain: "year" | "month";
  periods: string[];
  series: string[];
  hasTotal: boolean;
  hiddenTotal: boolean;
  mean: boolean;
  partialLast: boolean;
  rowsPerCell: number;
  cells: Map<string, number | null>; // `${period}|${series}` -> aggregated expected value (null = no rows)
}

function generate(seed: number): { spec: Spec; records: Rec[]; fields: ReturnType<typeof field>[] } {
  const r = rng(seed);
  const grain: "year" | "month" = r() < 0.5 ? "year" : "month";
  const nPeriods = 5 + Math.floor(r() * 10);
  const periods = Array.from({ length: nPeriods }, (_, i) =>
    grain === "year" ? String(2010 + i) : `${2020 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`,
  );
  const areaMode = r() < 0.2;
  const nParts = 2 + Math.floor(r() * 5);
  const hasTotal = !areaMode && r() < 0.4;
  const parts = Array.from({ length: nParts }, (_, i) => `Part ${String.fromCharCode(65 + i)}`);
  const series = areaMode ? ["value"] : hasTotal ? ["Total", ...parts] : parts;
  const hiddenTotal = r() < 0.4;
  const mean = r() < 0.3;
  const partialLast = !mean && r() < 0.3;
  const rowsPerCell = 2;
  // area mode needs a hidden dimension with > 8 values so it is not series-able
  const baseRegions = areaMode ? Array.from({ length: 9 }, (_, i) => `R${i + 1}`) : ["R1", "R2"];
  const regions = hiddenTotal ? [...baseRegions, "Total"] : baseRegions;

  const records: Rec[] = [];
  const cells = new Map<string, number | null>();
  periods.forEach((p, pi) => {
    series.forEach((s, si) => {
      const dropped = si > 0 && r() < 0.1; // series 0 always present so no period disappears
      if (dropped) {
        cells.set(`${p}|${s}`, null);
        return;
      }
      let sum = 0;
      let count = 0;
      for (const region of regions) {
        const isTotalRegion = region === "Total";
        const perRegionRows = pi === periods.length - 1 && partialLast ? 1 : rowsPerCell;
        for (let k = 0; k < perRegionRows; k++) {
          const v = isTotalRegion ? 7777 : 1 + Math.floor(r() * 999);
          const rec: Rec = grain === "year" ? { year: p } : { date: `${p}-01` };
          if (!areaMode) rec.series = s;
          rec.region = region;
          rec.v = v;
          records.push(rec);
          if (!isTotalRegion) {
            sum += v;
            count += 1;
          }
        }
      }
      cells.set(`${p}|${s}`, mean ? sum / count : sum);
    });
  });

  const fields = [
    grain === "year" ? field("year", "text", "Year") : field("date", "date", "Date"),
    ...(areaMode ? [] : [field("series", "text", "Series")]),
    field("region", "text", "Region"),
    field("v", "double", mean ? "Unemployment Rate" : "Number of Cases"),
  ];
  return { spec: { areaMode, grain, periods, series, hasTotal, hiddenTotal, mean, partialLast, rowsPerCell, cells }, records, fields };
}

const round4 = (n: number) => Math.round(n * 1e4) / 1e4;
const seen = { area: 0, totalSeries: 0, hiddenTotal: 0, partial: 0, meanWithheld: 0, sumOfSeries: 0, missingSeriesPeriod: 0 };

describe("derived fields are consistent with an independent oracle (120 seeded datasets)", () => {
  for (let seed = 1; seed <= 120; seed++) {
    it(`seed ${seed}`, async () => {
      const { spec, records, fields } = generate(seed);
      const out = await derive(records, fields);
      const viz = out.viz as Extract<VizConfig, { type: "area" | "multi-line" }>;
      expect(viz.type).toBe(spec.areaMode ? "area" : "multi-line");

      // 1. chart cells equal the oracle; hidden Total rows (7777) never leak in; gaps are null
      const periodsInChart = out.rows.map((r) => r.period as string);
      expect(periodsInChart).toEqual(spec.periods);
      const single = viz.type === "area";
      for (const row of out.rows) {
        if (single) {
          // one series only: the cell is that series' value
          expect(row.value).toBe(spec.cells.get(`${row.period}|${spec.series[0]}`) === null ? null : round4(spec.cells.get(`${row.period}|${spec.series[0]}`)!));
        } else {
          for (const s of spec.series) {
            const expected = spec.cells.get(`${row.period}|${s}`);
            expect(row[s], `${row.period} ${s}`).toBe(expected === null || expected === undefined ? null : round4(expected));
          }
        }
        for (const v of Object.values(row)) if (typeof v === "number") expect(Number.isFinite(v)).toBe(true);
      }
      if (viz.type === "multi-line") {
        expect([...viz.seriesValues].sort()).toEqual([...spec.series].sort());
        expect(viz.totalKey ?? null).toBe(spec.hasTotal ? "Total" : null);
        if (spec.hasTotal) expect(viz.seriesValues[0]).toBe("Total");
      }
      expect(viz.excludedTotals ?? []).toEqual(spec.hiddenTotal ? ["Total"] : []);

      // 2. independent headline oracle
      const flaggedPartial = viz.lastPeriodPartial === true;
      if (single) seen.area++;
      if (spec.hasTotal) seen.totalSeries++;
      if (spec.hiddenTotal) seen.hiddenTotal++;
      if (flaggedPartial) seen.partial++;
      if (!single && spec.mean && !spec.hasTotal) seen.meanWithheld++;
      if (!single && !spec.mean && !spec.hasTotal) seen.sumOfSeries++;
      if ([...spec.cells.values()].some((c) => c === null)) seen.missingSeriesPeriod++;
      if (spec.mean) expect(flaggedPartial).toBe(false);
      const valueAt = (p: string): number | null => {
        if (single) return spec.cells.get(`${p}|${spec.series[0]}`) ?? null;
        if (spec.hasTotal) return spec.cells.get(`${p}|Total`) ?? null;
        let sum = 0;
        for (const s of spec.series) {
          const c = spec.cells.get(`${p}|${s}`);
          if (c === null || c === undefined) return null;
          sum += c;
        }
        return sum;
      };
      const meanMultiNoTotal = !single && spec.mean && !spec.hasTotal;
      const usable = spec.periods.slice(0, flaggedPartial ? -1 : undefined).filter((p) => valueAt(p) !== null);

      if (meanMultiNoTotal || usable.length === 0) {
        expect(viz.headline).toBeNull();
      } else {
        const last = usable[usable.length - 1];
        const prev = flaggedPartial ? null : (usable[usable.length - 2] ?? null);
        expect(viz.headline).not.toBeNull();
        expect(viz.headline!.period).toBe(last);
        expect(viz.headline!.value).toBeCloseTo(round4(valueAt(last)!), 3);
        expect(viz.headline!.prevPeriod).toBe(prev);
        if (flaggedPartial) expect(viz.headline!.changePct).toBeNull();
      }

      // 3. headline == card/home metric == the number in the sentence
      const metric = extractFeaturedMetric(viz, out.chartData);
      if (viz.headline === null) {
        expect(metric).toBeNull();
        expect(out.summaryAr).toMatch(/^تحتوي قاعدة البيانات/);
      } else {
        expect(metric?.value).toBe(viz.headline!.value);
        expect(metric?.period).toBe(viz.headline!.period);
        expect(out.summaryAr).toContain(formatSummaryNumber(viz.headline!.value));
        // the sparkline never ends on the partial period and never contains a null/NaN
        for (const pt of metric!.points) expect(Number.isFinite(pt.y)).toBe(true);
        if (flaggedPartial) expect(metric!.points.some((pt) => pt.x === spec.periods[spec.periods.length - 1])).toBe(false);
        expect(metric!.points[metric!.points.length - 1].x).toBe(viz.headline!.period);
      }
    });
  }

  it("the 120 seeds exercise every branch (the oracle is not vacuous)", () => {
    for (const [branch, n] of Object.entries(seen)) expect(n, branch).toBeGreaterThanOrEqual(8);
  });
});
