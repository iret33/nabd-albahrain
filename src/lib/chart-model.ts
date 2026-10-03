/**
 * The pure "view model" under the dataset chart: which series exist and how
 * each is colored/dashed, how tall the canvas is, how axis numbers read, and
 * how a partial trailing period is split off so it can be drawn dashed.
 * `dataset-chart.tsx` (Recharts, lazy-loaded) and `chart-loader.tsx` (legend
 * + toolbar, rendered immediately) both build on this, so the legend, the
 * picture and the skeleton always agree.
 */

import type { VizConfig } from "@/lib/sync/derived";
import { formatCompactAr } from "@/lib/format";
import { seriesColorMap, seriesPalette, TOTAL_SERIES_COLOR } from "@/lib/theme-colors";

/** The bucket that holds the series left out of a bar-stacked chart. */
export const OTHER_LABEL = "أخرى";
/** A neutral grey (3.7:1 on white) so "everything else" never looks like one more category. */
export const OTHER_SERIES_COLOR = "#7B8794";
/** Dash for a chart's total line: it is a reference line, not one more category. */
export const TOTAL_DASH = "8 4";
/**
 * Redundant (non-color) encoding for the 5th..8th series: the fixed palette
 * keeps every pair distinguishable by color alone, the dash pattern is the
 * second cue for readers who still cannot tell two thin lines apart.
 */
const SERIES_DASHES = ["6 3", "2 3", "9 3 2 3", "1 4"] as const;

/** Suffix of the twin series that carries a partial trailing period. */
export const PARTIAL_SUFFIX = "__partial";

export interface SeriesSpec {
  /** The chartData key. */
  key: string;
  label: string;
  color: string;
  /** SVG stroke-dasharray, when the series is drawn dashed. */
  dash?: string;
  /** The chart's total series (neutral, dashed, never stacked). */
  total: boolean;
}

/** Series of a chart in legend order (which is also stack order, bottom first). */
export function seriesSpecs(vizConfig: VizConfig, baseColor: string): SeriesSpec[] {
  switch (vizConfig.type) {
    case "area":
    case "bar-h":
      return [{ key: "value", label: vizConfig.measureLabel, color: baseColor, total: false }];
    case "histogram":
      return [{ key: "count", label: "العدد", color: baseColor, total: false }];
    case "multi-line": {
      const keys = vizConfig.seriesValues;
      const totalKey = vizConfig.totalKey && keys.includes(vizConfig.totalKey) ? vizConfig.totalKey : null;
      const colors = seriesColorMap(keys, baseColor, totalKey);
      let index = 0;
      return keys.map((key) => {
        if (key === totalKey) return { key, label: key, color: colors[key], dash: TOTAL_DASH, total: true };
        const n = index++;
        return { key, label: key, color: colors[key], dash: n >= 4 ? SERIES_DASHES[(n - 4) % SERIES_DASHES.length] : undefined, total: false };
      });
    }
    case "bar-stacked": {
      const keys = vizConfig.seriesValues;
      // The derivation renames its synthetic bucket when a REAL category is already called "أخرى".
      const otherLabel = vizConfig.otherLabel ?? OTHER_LABEL;
      const bucketed = vizConfig.otherSeriesBucketed === true && keys[keys.length - 1] === otherLabel;
      const named = bucketed ? keys.slice(0, -1) : keys;
      const palette = seriesPalette(baseColor, named.length);
      const specs: SeriesSpec[] = named.map((key, i) => ({ key, label: key, color: palette[i], total: false }));
      if (bucketed) specs.push({ key: otherLabel, label: otherLabel, color: OTHER_SERIES_COLOR, total: false });
      return specs;
    }
    default:
      return [];
  }
}

export { TOTAL_SERIES_COLOR };

// ---------------------------------------------------------------------------
// Canvas size
// ---------------------------------------------------------------------------

export interface CanvasSize {
  /** Tailwind height classes for the responsive types. */
  className: string;
  /** Pixel height for the data-dependent types (bars grow with their categories). */
  height?: number;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/**
 * The chart's canvas height, known BEFORE Recharts loads so the lazy-loading
 * skeleton can reserve exactly the same box (no layout shift).
 */
export function canvasSize(vizConfig: VizConfig, rowCount: number): CanvasSize {
  if (vizConfig.type === "bar-h") return { className: "", height: clamp(rowCount * 34, 240, 560) };
  if (vizConfig.type === "bar-stacked") return { className: "", height: clamp(rowCount * 40, 280, 520) };
  return { className: "h-72 sm:h-80" };
}

// ---------------------------------------------------------------------------
// Axis numbers
// ---------------------------------------------------------------------------

/**
 * Tick formatter for a value axis whose largest magnitude is `maxAbs`: compact
 * in Arabic units (formatCompactAr: "1.5 مليون") from 1,000 up, otherwise just enough decimals that neighbouring
 * ticks never print the same label (0.25 must not collapse to "0.3" twice).
 * Latin digits throughout.
 */
export function axisNumberFormatter(maxAbs: number): (n: number) => string {
  if (maxAbs >= 1000) return formatCompactAr;
  const digits = maxAbs >= 100 ? 0 : maxAbs >= 10 ? 1 : maxAbs >= 1 ? 2 : maxAbs >= 0.01 ? 3 : 4;
  const f = new Intl.NumberFormat("en-US", { maximumFractionDigits: digits });
  return (n) => f.format(n);
}

/** Pixel width of a value axis wide enough for its longest tick label (12px digits are ~6.8px wide). */
export function valueAxisWidth(format: (n: number) => string, min: number, max: number): number {
  const longest = Math.max(format(Math.abs(max)).length, format(min < 0 ? min : 0).length, format(max).length);
  return clamp(Math.ceil(longest * 6.8) + 14, 36, 96);
}

export interface ValueExtent {
  min: number;
  max: number;
}

/**
 * Min/max of what will be drawn: per-row sums when bars are stacked, plain
 * values otherwise. `keys` are the visible series only.
 */
export function valueExtent(
  rows: ReadonlyArray<Record<string, unknown>>,
  keys: readonly string[],
  stacked: boolean,
): ValueExtent {
  let min = 0;
  let max = 0;
  for (const row of rows) {
    let positive = 0;
    let negative = 0;
    for (const key of keys) {
      const v = row[key];
      if (typeof v !== "number" || !Number.isFinite(v)) continue;
      if (stacked) {
        if (v >= 0) positive += v;
        else negative += v;
      } else {
        if (v > max) max = v;
        if (v < min) min = v;
      }
    }
    if (stacked) {
      if (positive > max) max = positive;
      if (negative < min) min = negative;
    }
  }
  return { min, max };
}

/** `label` cut to `max` characters with an ellipsis (full text stays in the tooltip). */
export function truncateLabel(label: string, max: number): string {
  const chars = Array.from(label);
  return chars.length <= max ? label : `${chars.slice(0, Math.max(1, max - 1)).join("")}…`;
}

/** Width of the category axis of a horizontal bar chart: fits the longest (truncated) label, within bounds. */
export function categoryAxisWidth(labels: readonly string[], maxChars: number): number {
  const longest = labels.reduce((m, l) => Math.max(m, Array.from(truncateLabel(l, maxChars)).length), 0);
  return clamp(Math.ceil(longest * 6.4) + 16, 80, 200);
}

// ---------------------------------------------------------------------------
// Gaps, isolated points, partial trailing period
// ---------------------------------------------------------------------------

/** Indices whose value is drawn but both neighbours are gaps: a line would show nothing there without a dot. */
export function isolatedIndices(values: ReadonlyArray<number | null | undefined>): Set<number> {
  const isNum = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v);
  const out = new Set<number>();
  values.forEach((v, i) => {
    if (isNum(v) && !isNum(values[i - 1]) && !isNum(values[i + 1])) out.add(i);
  });
  return out;
}

/** Chart types small enough to dot every point (and to label with a dot per period). */
export const DOT_THRESHOLD = 24;

/**
 * Adds a `<key>__partial` twin to every row for each series: the last row's
 * value moves from the solid series to the twin, and the previous row's value
 * is copied to the twin so the dashed segment starts where the solid line
 * ends. Gaps stay null. With fewer than two rows nothing is split.
 */
export function splitPartial(
  rows: ReadonlyArray<Record<string, unknown>>,
  keys: readonly string[],
): Array<Record<string, unknown>> {
  const out = rows.map((r) => ({ ...r }));
  if (out.length < 2) return out;
  const last = out.length - 1;
  for (const key of keys) {
    const partialKey = `${key}${PARTIAL_SUFFIX}`;
    for (const row of out) row[partialKey] = null;
    const lastValue = out[last][key];
    const prevValue = out[last - 1][key];
    out[last][partialKey] = typeof lastValue === "number" ? lastValue : null;
    out[last][key] = null;
    out[last - 1][partialKey] = typeof prevValue === "number" ? prevValue : null;
  }
  return out;
}

/** The period label of the trailing row when the chart flags it as incomplete, else null. */
export function partialPeriodOf(vizConfig: VizConfig, rows: ReadonlyArray<Record<string, unknown>>): string | null {
  if (vizConfig.type !== "area" && vizConfig.type !== "multi-line") return null;
  if (!vizConfig.lastPeriodPartial || rows.length < 2) return null;
  const period = rows[rows.length - 1]?.period;
  return typeof period === "string" ? period : null;
}
