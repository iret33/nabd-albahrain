/**
 * The ONE headline implementation.
 *
 * "Headline" = the single most recent comparable value of a temporal chart
 * (big number + % change on the home band, the sparkline end point, and the
 * lead sentence on the dataset page). It used to be computed twice with
 * different rules (render-time `extractFeaturedMetric` vs. sync-time
 * `buildSummaryAr`), so the card said ~1.5M while the page said ~4.7M. Both
 * now call `headlineSeries` / `computeHeadline` from here, and the result is
 * persisted into `vizConfig.headline` at sync time so render-time code only
 * recomputes for rows synced before this module existed.
 *
 * Rules (each one comes from a reproduced bug):
 *  - A labeled total series is used as-is and NEVER summed with its parts.
 *    Two or more total-looking series ("Total Imports" / "Total Exports")
 *    are ambiguous -> no headline, instead of silently taking the first.
 *  - Mean aggregates (rates, percentages, indices) are not additive, so a
 *    multi-series mean chart has no headline unless a single total/overall
 *    series exists.
 *  - Without a total, series are summed only for periods where EVERY series
 *    is present: a series absent in the last period would otherwise look
 *    like a drop. Likewise the previous period is the latest earlier period
 *    with the same series set present (like for like).
 *  - A partial trailing period (`lastPeriodPartial`) is excluded: the
 *    headline is the last complete period and carries no % change.
 *  - Pure, dependency-free apart from series.ts: no DOM, no Prisma, no Intl
 *    locale data (month names are a fixed table so a stored sentence never
 *    depends on the ICU build of the host that synced it).
 */

import { findTotalSeries, sumSeriesRow, isAdjacentPeriod, type Grain } from "@/lib/series";
import { ARABIC_MONTH_NAMES } from "@/lib/temporal";

export interface TrendPoint {
  x: string;
  y: number;
}

export type HeadlineBasis = "single" | "total-series" | "sum-of-series";

/** Persisted into `vizConfig.headline` for temporal (area / multi-line) charts. */
export interface Headline {
  value: number;
  period: string;
  prevValue: number | null;
  prevPeriod: string | null;
  changePct: number | null;
  basis: HeadlineBasis;
}

/** The structural subset of a temporal VizConfig the headline rules need (keeps this module free of derived.ts). */
export interface HeadlineSource {
  type: string;
  aggregate?: "sum" | "mean" | "last";
  seriesValues?: string[];
  seriesOverflow?: boolean;
  /** Persisted single total series; undefined for rows synced before it existed (detected from the labels then). */
  totalKey?: string | null;
  lastPeriodPartial?: boolean;
}

export interface HeadlineSeries {
  basis: HeadlineBasis;
  /** One value per usable period, ascending; periods with a missing series or a null are absent. */
  points: TrendPoint[];
  /** The excluded partial trailing period, or null. */
  partialPeriod: string | null;
  /** The series used for the values when basis is "total-series". */
  totalKey: string | null;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * The per-period headline values of a temporal chart under the rules above,
 * or null when the chart has no meaningful single number. `includePartial`
 * keeps the partial trailing period (for drawing a full chart); the headline
 * and sparkline callers leave it off.
 */
export function headlineSeries(
  src: HeadlineSource,
  rows: ReadonlyArray<Record<string, unknown>>,
  opts: { includePartial?: boolean } = {},
): HeadlineSeries | null {
  if (!Array.isArray(rows) || rows.length === 0) return null;

  let basis: HeadlineBasis;
  let totalKey: string | null = null;
  let valueOf: (row: Record<string, unknown>) => number | null;

  if (src.type === "area") {
    basis = "single";
    valueOf = (row) => (isFiniteNumber(row.value) ? row.value : null);
  } else if (src.type === "multi-line") {
    const keys = Array.isArray(src.seriesValues) ? src.seriesValues : [];
    if (keys.length === 0) return null;

    if (typeof src.totalKey === "string" && keys.includes(src.totalKey)) {
      totalKey = src.totalKey;
    } else {
      const detected = findTotalSeries(keys);
      if (detected.ambiguous) return null;
      totalKey = detected.key;
    }

    if (totalKey) {
      basis = "total-series";
      const tk = totalKey;
      valueOf = (row) => (isFiniteNumber(row[tk]) ? (row[tk] as number) : null);
    } else {
      // Rates/percentages/indices are not additive: summing male + female
      // unemployment rate is nonsense, and an unlabeled "total" cannot be invented.
      if (src.aggregate === "mean") return null;
      // The plotted series are a truncated list: the sum would silently omit series.
      if (src.seriesOverflow) return null;
      basis = keys.length === 1 ? "single" : "sum-of-series";
      valueOf = (row) => sumSeriesRow(row, keys, { requireAll: true });
    }
  } else {
    return null;
  }

  // chartData is persisted JSON: tolerate a damaged row instead of throwing in a page render.
  const isRow = (r: unknown): r is Record<string, unknown> => !!r && typeof r === "object" && !Array.isArray(r);
  const lastRow = rows[rows.length - 1];
  const partialPeriod =
    src.lastPeriodPartial && isRow(lastRow) && typeof lastRow.period === "string" ? lastRow.period : null;
  const dropPartial = partialPeriod !== null && !opts.includePartial;

  const points: TrendPoint[] = [];
  for (const row of rows) {
    if (!isRow(row) || typeof row.period !== "string") continue;
    if (dropPartial && row.period === partialPeriod) continue;
    const y = valueOf(row);
    if (y !== null) points.push({ x: row.period, y });
  }
  if (points.length === 0) return null;
  return { basis, points, partialPeriod, totalKey };
}

/**
 * The headline of a temporal chart: last usable period, plus the latest
 * earlier usable period for the % change (omitted when the trailing period
 * was partial, or the previous value is 0).
 */
export function computeHeadline(
  src: HeadlineSource,
  rows: ReadonlyArray<Record<string, unknown>>,
): Headline | null {
  const series = headlineSeries(src, rows);
  if (!series) return null;
  const { points, basis } = series;
  const last = points[points.length - 1];
  const prev = src.lastPeriodPartial ? null : (points[points.length - 2] ?? null);
  const changePct =
    prev && prev.y !== 0 && Number.isFinite(prev.y) ? ((last.y - prev.y) / Math.abs(prev.y)) * 100 : null;
  return {
    value: last.y,
    period: last.x,
    prevValue: prev ? prev.y : null,
    prevPeriod: prev ? prev.x : null,
    changePct: changePct === null ? null : Math.round(changePct * 100) / 100,
    basis,
  };
}

/** Structural guard for a persisted `vizConfig.headline` (old rows have none; hand-edited JSON may be malformed). */
export function isHeadline(value: unknown): value is Headline {
  if (!value || typeof value !== "object") return false;
  const h = value as Record<string, unknown>;
  return (
    isFiniteNumber(h.value) &&
    typeof h.period === "string" &&
    (h.basis === "single" || h.basis === "total-series" || h.basis === "sum-of-series")
  );
}

// ---------------------------------------------------------------------------
// Summary-sentence formatting (Latin digits, grouped thousands)
// ---------------------------------------------------------------------------

const groupedFormatters = new Map<number, Intl.NumberFormat>();

function formatterFor(maxFractionDigits: number): Intl.NumberFormat {
  let f = groupedFormatters.get(maxFractionDigits);
  if (!f) {
    f = new Intl.NumberFormat("en-US", { maximumFractionDigits: maxFractionDigits });
    groupedFormatters.set(maxFractionDigits, f);
  }
  return f;
}

const sigFormatter = new Intl.NumberFormat("en-US", { maximumSignificantDigits: 2 });

/**
 * Number for an Arabic sentence: Latin digits and en-US grouping (matching
 * `formatNumber` everywhere else in the UI). Fraction digits depend on the
 * MAGNITUDE (Math.abs - negatives must not get extra decimals): 2 below 10,
 * 1 below 100, none from 100; values under 1 keep two significant digits so
 * 0.0042 does not collapse to "0".
 */
export function formatSummaryNumber(n: number): string {
  if (!Number.isFinite(n)) return "0";
  if (n === 0) return "0";
  const abs = Math.abs(n);
  if (abs < 1) return sigFormatter.format(n);
  const digits = abs < 10 ? 2 : abs < 100 ? 1 : 0;
  const out = formatterFor(digits).format(n);
  return out === "-0" ? "0" : out;
}

/**
 * A period key as Arabic text: "2026-03" -> "مارس 2026" (a bare "2026-03"
 * inside an RTL sentence used to render as "-032026"), a year stays "2026".
 * Anything else is returned untouched.
 */
export function formatPeriodAr(period: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(period);
  if (!m) return period;
  const month = Number(m[2]);
  if (month < 1 || month > 12) return period;
  return `${ARABIC_MONTH_NAMES[month - 1]} ${m[1]}`;
}

/** "5.5" + "%" -> "5.5%"; "1,200" + "km2" -> "1,200 km2". */
export function withUnit(valueText: string, unit: string | undefined | null): string {
  if (!unit) return valueText;
  return unit === "%" || unit === "٪" ? `${valueText}${unit}` : `${valueText} ${unit}`;
}

/**
 * The lead sentence for a temporal chart's headline.
 *   normal:  "آخر قيمة مسجلة: 1,497,471 في مارس 2026، بتغير +2.3% عن الفترة السابقة."
 *   partial: "آخر قيمة مسجلة لفترة مكتملة: 42,403 في 2025، علماً بأن بيانات 2026 غير مكتملة."
 */
export function buildHeadlineSentence(args: {
  headline: Headline;
  unit?: string;
  grain: Grain;
  /** Cadence of the series in grain units (3 for a quarterly month-grain series). */
  step?: number;
  /** Period key of the excluded partial trailing period, when the headline skipped one. */
  partialPeriod?: string | null;
}): string {
  const { headline, unit, grain, step = 1, partialPeriod } = args;
  const value = withUnit(formatSummaryNumber(headline.value), unit);
  const when = formatPeriodAr(headline.period);

  if (partialPeriod) {
    return `آخر قيمة مسجلة لفترة مكتملة: ${value} في ${when}، علماً بأن بيانات ${formatPeriodAr(partialPeriod)} غير مكتملة.`;
  }

  let sentence = `آخر قيمة مسجلة: ${value} في ${when}`;
  if (headline.changePct !== null && headline.prevPeriod !== null) {
    const magnitude = Math.abs(headline.changePct).toFixed(1);
    // "-0.0%" reads as a decline that is not there.
    const sign = headline.changePct < 0 && magnitude !== "0.0" ? "-" : "+";
    const against = isAdjacentPeriod(headline.prevPeriod, headline.period, grain, step)
      ? "الفترة السابقة"
      : formatPeriodAr(headline.prevPeriod);
    sentence += `، بتغير ${sign}${magnitude}% عن ${against}`;
  }
  return sentence + ".";
}
