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
    const points: TrendPoint[] = [];
    for (const row of rows) {
      const period = row.period;
      if (typeof period !== "string") continue;
      const sum = sumSeriesRow(row, vizConfig.seriesValues);
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
