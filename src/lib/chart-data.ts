/**
 * Small pure helpers for turning a Dataset's precomputed `vizConfig` +
 * `chartData` into shapes the presentational chart components need.
 * Nothing here touches the database — it's the pure "view model" layer
 * between the query results and the Recharts components.
 */

import type { VizConfig } from "@/lib/sync/derived";

export interface TrendPoint {
  x: string;
  y: number;
}

export interface FeaturedMetric {
  value: number;
  period: string;
  unit?: string;
  points: TrendPoint[];
}

function sumSeriesRow(row: Record<string, unknown>, seriesValues: string[]): number | null {
  let sum = 0;
  let any = false;
  for (const key of seriesValues) {
    const v = row[key];
    if (typeof v === "number") {
      sum += v;
      any = true;
    }
  }
  return any ? sum : null;
}

/**
 * Phase 8 fix, found while spot-checking real synced data for
 * `src/config/featured.ts`: a multi-line chart's `seriesField` dimension
 * very commonly includes a value that's already a grand total of the
 * *other* values in that same dimension — e.g.
 * `01-caa-monthly-passenger-movement-at-bahrain-international-airport`'s
 * `data_type` series is `["Passengers Total", "Passengers Disembark",
 * "Passengers Transfers", "Passengers Embark", "Passengers Transit"]`.
 * Blindly summing every series value (the previous behavior) therefore
 * summed the total together with its own components, producing a wildly
 * inflated figure (~4.7M instead of the real ~1.5M passengers) — wrong on
 * every `DatasetCard` sparkline this dataset appears on (categories,
 * publishers, search, "latest") as well as the home page's featured band.
 * A genuinely additive partition (e.g. Bahraini/Non-Bahraini population,
 * with no "Total" row) is unaffected and still gets summed as before.
 *
 * Data-driven equality checks (does one series' value equal the sum of
 * the others across every row?) turned out to be unreliable on this exact
 * dataset — "Passengers Total" doesn't cleanly equal any subset sum of
 * its siblings across all rows, likely because embark/disembark/transit/
 * transfer are overlapping classification systems, not a strict
 * partition. A label match is simpler and more robust here: government
 * statistical tables consistently label their own totals as such, so
 * trust that existing label instead of reverse-engineering the math.
 */
const TOTAL_SERIES_LABEL_PATTERN = /\btotal\b|\bgrand\s*total\b|إجمالي|مجموع/i;

function pickTotalSeriesKey(seriesValues: string[]): string | null {
  if (seriesValues.length < 2) return null;
  return seriesValues.find((v) => TOTAL_SERIES_LABEL_PATTERN.test(v)) ?? null;
}

/**
 * Extracts a "big number + trend" metric from a dataset's chartData, for
 * the home page's featured-stats band and dataset-card sparklines. Only
 * temporal chart types (`area` / `multi-line`) have an obvious single
 * trend line, so anything else returns null — callers must degrade
 * gracefully (skip the entry) rather than render a broken sparkline.
 */
export function extractFeaturedMetric(vizConfig: VizConfig | null, chartData: unknown[] | null): FeaturedMetric | null {
  if (!vizConfig || !Array.isArray(chartData) || chartData.length === 0) return null;

  if (vizConfig.type === "area") {
    const rows = chartData as Array<{ period?: unknown; value?: unknown }>;
    const points: TrendPoint[] = [];
    for (const row of rows) {
      if (typeof row.period === "string" && typeof row.value === "number") {
        points.push({ x: row.period, y: row.value });
      }
    }
    if (points.length === 0) return null;
    const last = points[points.length - 1];
    return { value: last.y, period: last.x, unit: vizConfig.unit, points };
  }

  if (vizConfig.type === "multi-line") {
    const rows = chartData as Array<Record<string, unknown>>;
    // If one series value is already labeled as a total of the others
    // (see pickTotalSeriesKey's doc comment above), use just that value
    // per row instead of summing everything and double-counting it.
    const totalKey = pickTotalSeriesKey(vizConfig.seriesValues);
    const points: TrendPoint[] = [];
    for (const row of rows) {
      const period = row.period;
      if (typeof period !== "string") continue;
      const sum = totalKey
        ? (typeof row[totalKey] === "number" ? (row[totalKey] as number) : null)
        : sumSeriesRow(row, vizConfig.seriesValues);
      if (sum !== null) points.push({ x: period, y: sum });
    }
    if (points.length === 0) return null;
    const last = points[points.length - 1];
    return { value: last.y, period: last.x, unit: vizConfig.unit, points };
  }

  return null;
}

/** True when a dataset's chart is a temporal one worth rendering as a mini sparkline on a card. */
export function looksTemporal(vizConfig: VizConfig | null): boolean {
  return vizConfig?.type === "area" || vizConfig?.type === "multi-line";
}
