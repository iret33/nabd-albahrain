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
 *  - Series that are not parts of one whole are never summed: a series named
 *    like a rate ("Unemployment Rate (%)"), an "indicator / measure / pollutant"
 *    series dimension, or series whose magnitudes differ by five orders cannot
 *    be added together. The headline is withheld (null) instead of a number
 *    that adds persons to percentages.
 *  - A series that equals the sum of all the others in (nearly) every period is
 *    the total even when its label does not say so ("Kingdom of Bahrain" next
 *    to its four governorates); labels alone only nominate candidates.
 *  - A partial trailing period (`lastPeriodPartial`) is excluded: the
 *    headline is the last complete period and carries no % change.
 *  - Pure, dependency-free apart from series.ts: no DOM, no Prisma, no Intl
 *    locale data (month names are a fixed table so a stored sentence never
 *    depends on the ICU build of the host that synced it).
 */

import {
  findNumericTotalSeries,
  findTotalSeries,
  isAdjacentPeriod,
  isIndicatorDimensionName,
  isNonAdditiveSeriesName,
  median,
  sumSeriesRow,
  type Grain,
} from "@/lib/series";
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
  /** Present (true) only when the headline period's rows carried a provisional marker ("2024*"): the sentence says so. */
  provisional?: true;
}

/** Why a temporal chart has no single headline number (persisted next to `headline: null`). */
export type HeadlineWithheld =
  | "ambiguous-total" // two or more "Total X" series: any pick would be arbitrary
  | "mean-series" // several series of rates/indices: not additive
  | "mixed-series" // series are different indicators / units, not parts of one whole
  | "overflow" // the plotted series are a truncated list: their sum would omit some
  | "unweighted-mean"; // a mean over parts whose published Total could not be used

/** The structural subset of a temporal VizConfig the headline rules need (keeps this module free of derived.ts). */
export interface HeadlineSource {
  type: string;
  aggregate?: "sum" | "mean" | "last";
  seriesValues?: string[];
  seriesOverflow?: boolean;
  /** Persisted single total series; undefined for rows synced before it existed (detected from the labels then). */
  totalKey?: string | null;
  /** The series dimension's field name / label: an "indicator"-like dimension is not a partition. */
  seriesField?: string;
  seriesLabel?: string;
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

/** Series whose median magnitudes differ by at least this factor cannot be parts of one whole (persons next to a rate). */
const HETEROGENEOUS_SPREAD = 1e5;

/**
 * True when the plotted series cannot be summed because they are not parts of
 * one whole. Name based first (cheap, explainable), then a magnitude backstop
 * for neutral labels ("Item", "Description"). Deliberately NOT applied to a
 * chart that has a labeled total: that branch never sums.
 */
export function seriesAreHeterogeneous(
  src: Pick<HeadlineSource, "seriesValues" | "seriesField" | "seriesLabel">,
  rows: ReadonlyArray<Record<string, unknown>>,
): boolean {
  const keys = Array.isArray(src.seriesValues) ? src.seriesValues : [];
  if (keys.length < 2) return false;
  if (keys.some((k) => isNonAdditiveSeriesName(k))) return true;
  if (isIndicatorDimensionName(src.seriesField, src.seriesLabel)) return true;

  const medians: number[] = [];
  for (const k of keys) {
    const values: number[] = [];
    for (const row of rows) {
      const v = row && typeof row === "object" ? (row as Record<string, unknown>)[k] : undefined;
      if (isFiniteNumber(v)) values.push(Math.abs(v));
    }
    const m = median(values);
    if (m > 0) medians.push(m);
  }
  return medians.length >= 2 && Math.max(...medians) / Math.min(...medians) >= HETEROGENEOUS_SPREAD;
}

type Plan =
  | { ok: true; basis: HeadlineBasis; totalKey: string | null; valueOf: (row: Record<string, unknown>) => number | null }
  | { ok: false; reason: HeadlineWithheld | null };

/** Decides how (and whether) a temporal chart reduces to one number per period. */
function planHeadline(src: HeadlineSource, rows: ReadonlyArray<Record<string, unknown>>): Plan {
  if (src.type === "area") {
    return { ok: true, basis: "single", totalKey: null, valueOf: (row) => (isFiniteNumber(row.value) ? row.value : null) };
  }
  if (src.type !== "multi-line") return { ok: false, reason: null };

  const keys = Array.isArray(src.seriesValues) ? src.seriesValues : [];
  if (keys.length === 0) return { ok: false, reason: null };

  let totalKey: string | null = null;
  if (typeof src.totalKey === "string" && keys.includes(src.totalKey)) {
    totalKey = src.totalKey;
  } else {
    const detected = findTotalSeries(keys);
    if (detected.ambiguous) return { ok: false, reason: "ambiguous-total" };
    totalKey = detected.key;
    // Rows persisted before `totalKey` existed (undefined, not null): a series that numerically IS the sum of
    // the others is the total. A persisted null means the engine already looked and found none.
    if (totalKey === null && src.totalKey === undefined && src.aggregate !== "mean" && !src.seriesOverflow) {
      totalKey = findNumericTotalSeries(rows, keys);
    }
  }

  if (totalKey) {
    const tk = totalKey;
    return { ok: true, basis: "total-series", totalKey, valueOf: (row) => (isFiniteNumber(row[tk]) ? (row[tk] as number) : null) };
  }

  // Rates/percentages/indices are not additive: summing male + female
  // unemployment rate is nonsense, and an unlabeled "total" cannot be invented.
  if (src.aggregate === "mean") return { ok: false, reason: "mean-series" };
  // The plotted series are a truncated list: the sum would silently omit series.
  if (src.seriesOverflow) return { ok: false, reason: "overflow" };
  if (keys.length > 1 && seriesAreHeterogeneous(src, rows)) return { ok: false, reason: "mixed-series" };
  return {
    ok: true,
    basis: keys.length === 1 ? "single" : "sum-of-series",
    totalKey: null,
    valueOf: (row) => sumSeriesRow(row, keys, { requireAll: true }),
  };
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
  const plan = planHeadline(src, rows);
  if (!plan.ok) return null;
  const { basis, totalKey, valueOf } = plan;

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
 * Why `headlineSeries` / `computeHeadline` returned nothing for a multi-series
 * chart (persisted as `vizConfig.headlineWithheld` so the caption can say so),
 * or null when the chart has a headline or simply has no usable data.
 */
export function headlineWithheldReason(
  src: HeadlineSource,
  rows: ReadonlyArray<Record<string, unknown>>,
): HeadlineWithheld | null {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const plan = planHeadline(src, rows);
  return plan.ok ? null : plan.reason;
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
// Number formatting: ONE convention for the sentence, the home card, the stats
// tiles and the chart tooltip (the exact-data table alone keeps full precision)
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
 * The shared rule, for a FINITE number. Latin digits and en-US grouping
 * (matching `formatNumber` everywhere else in the UI). Fraction digits depend
 * on the MAGNITUDE (Math.abs: negatives must not get extra decimals): up to 2
 * below 100, 1 below 1,000, none from 1,000; values under 1 keep two
 * significant digits so 0.0042 does not collapse to "0". Trailing zeros are
 * not printed ("4.4", not "4.40"), a "-0" never is.
 */
function formatMagnitude(n: number): string {
  if (n === 0) return "0";
  const abs = Math.abs(n);
  if (abs < 1) return sigFormatter.format(n);
  const digits = abs < 100 ? 2 : abs < 1000 ? 1 : 0;
  const out = formatterFor(digits).format(n);
  return out === "-0" ? "0" : out;
}

/**
 * The number as it appears in an Arabic sentence. Non-finite input prints "0"
 * (sentence callers only pass the finite `headline.value`; a sentence must
 * never contain an em dash). Same digits as `formatDisplayNumber`.
 */
export function formatSummaryNumber(n: number): string {
  return Number.isFinite(n) ? formatMagnitude(n) : "0";
}

/**
 * The same number for UI chrome (home card, stats tiles, chart tooltip):
 * identical digits to the lead sentence, and "—" for a missing/non-finite
 * value instead of a misleading "0". The records table is the exact-data view
 * and deliberately keeps up to 4 decimals.
 */
export function formatDisplayNumber(n: number | null | undefined): string {
  return typeof n === "number" && Number.isFinite(n) ? formatMagnitude(n) : "—";
}

export interface ChangeDisplay {
  /** Drives the arrow and the tone: "flat" when the change rounds to 0.0. */
  direction: "up" | "down" | "flat";
  /** The rounded magnitude without sign, e.g. "2.6". */
  magnitude: string;
  /** Sign + magnitude + "%": "+2.6%", "-7.7%", and "0.0%" (no sign) for flat. */
  text: string;
}

/**
 * The ONE percent-change convention: one decimal, rounded with `toFixed` on the
 * magnitude (so -0.25 and +0.25 round the same way), and a change that rounds to
 * 0.0 is "flat" with NO sign and no arrow direction (a "-0.0%" reads as a decline
 * that is not there, a "+0.0%" as growth). The sentence, the home card, the
 * stats badge and the arrow must all derive from this one result. Large
 * magnitudes are grouped ("1,234.5%").
 */
export function formatChangePercent(pct: number): ChangeDisplay {
  if (!Number.isFinite(pct)) return { direction: "flat", magnitude: "0.0", text: "0.0%" };
  let magnitude = Math.abs(pct).toFixed(1);
  if (magnitude === "0.0") return { direction: "flat", magnitude, text: "0.0%" };
  if (!magnitude.includes("e")) {
    const [int, frac] = magnitude.split(".");
    magnitude = `${int.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${frac}`;
  }
  return pct < 0
    ? { direction: "down", magnitude, text: `-${magnitude}%` }
    : { direction: "up", magnitude, text: `+${magnitude}%` };
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
  // A provisional figure says so right next to its period ("2024 (بيانات أولية)").
  const when = formatPeriodAr(headline.period) + (headline.provisional ? " (بيانات أولية)" : "");

  if (partialPeriod) {
    return `آخر قيمة مسجلة لفترة مكتملة: ${value} في ${when}، علماً بأن بيانات ${formatPeriodAr(partialPeriod)} غير مكتملة.`;
  }

  let sentence = `آخر قيمة مسجلة: ${value} في ${when}`;
  if (headline.changePct !== null && headline.prevPeriod !== null) {
    const against = isAdjacentPeriod(headline.prevPeriod, headline.period, grain, step)
      ? "الفترة السابقة"
      : formatPeriodAr(headline.prevPeriod);
    sentence += `، بتغير ${formatChangePercent(headline.changePct).text} عن ${against}`;
  }
  return sentence + ".";
}
