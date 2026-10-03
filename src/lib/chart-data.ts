/**
 * Small pure helpers for turning a Dataset's precomputed `vizConfig` +
 * `chartData` into shapes the presentational chart components need.
 * Nothing here touches the database — it's the pure "view model" layer
 * between the query results and the Recharts components.
 *
 * Every number shown as a "headline" (home band, card sparklines) goes
 * through `src/lib/headline.ts`, the same module `derived.ts` used at sync
 * time to persist `vizConfig.headline`; this file only READS that persisted
 * value and recomputes with the shared function for rows synced before it
 * existed (old vizConfig shapes must never crash a page).
 */

import type { VizConfig } from "@/lib/sync/derived";
import {
  headlineSeries,
  computeHeadline,
  isHeadline,
  type Headline,
  type HeadlineBasis,
  type HeadlineSource,
  type TrendPoint,
} from "@/lib/headline";
import { formatPeriodAr } from "@/lib/headline";
import { parsePeriod, type Grain } from "@/lib/series";

export type { TrendPoint } from "@/lib/headline";

export interface FeaturedMetric {
  value: number;
  period: string;
  unit?: string;
  points: TrendPoint[];
  /** % change vs the previous comparable period; absent when unknown or when the trailing period was partial. */
  changePct?: number | null;
  prevValue?: number | null;
  prevPeriod?: string | null;
  basis?: HeadlineBasis;
  /** True when a partial trailing period was left out of `value` and `points`. */
  partial?: boolean;
  /** True when the headline period's rows carried a provisional marker ("2024*"): UI may label the figure "أولية". */
  provisional?: boolean;
}

function isTemporalConfig(vizConfig: VizConfig | null): vizConfig is Extract<VizConfig, { type: "area" | "multi-line" }> {
  return vizConfig?.type === "area" || vizConfig?.type === "multi-line";
}

/**
 * The trend of a temporal chart under the shared headline rules (a labeled
 * total is used as-is, never summed with its parts; mean series and ambiguous
 * totals have none; periods where a series is missing are skipped).
 * `includePartial` keeps a partial trailing period, for drawing the whole
 * chart with the last segment dashed.
 */
export function extractTrendSeries(
  vizConfig: VizConfig | null,
  chartData: unknown[] | null,
  opts: { includePartial?: boolean } = {},
): { points: TrendPoint[]; partialPeriod: string | null; basis: HeadlineBasis } | null {
  if (!isTemporalConfig(vizConfig) || !Array.isArray(chartData) || chartData.length === 0) return null;
  const rows = chartData as Array<Record<string, unknown>>;
  const series = headlineSeries(vizConfig as HeadlineSource, rows, opts);
  return series ? { points: series.points, partialPeriod: series.partialPeriod, basis: series.basis } : null;
}

/**
 * Extracts a "big number + trend" metric from a dataset's chartData, for
 * the home page's featured-stats band and dataset-card sparklines. Only
 * temporal chart types (`area` / `multi-line`) have an obvious single
 * trend line, so anything else returns null — callers must degrade
 * gracefully (skip the entry) rather than render a broken sparkline. A
 * temporal chart whose headline is deliberately withheld (ambiguous totals,
 * rates that cannot be summed) also returns null instead of a made-up number.
 */
export function extractFeaturedMetric(vizConfig: VizConfig | null, chartData: unknown[] | null): FeaturedMetric | null {
  if (!isTemporalConfig(vizConfig) || !Array.isArray(chartData) || chartData.length === 0) return null;
  const rows = chartData as Array<Record<string, unknown>>;

  // `null` was persisted on purpose (see TemporalMeta.headline); `undefined`
  // (or a malformed value) means an old row: recompute with the same rules.
  const persisted: unknown = (vizConfig as { headline?: unknown }).headline;
  if (persisted === null) return null;

  const trend = extractTrendSeries(vizConfig, chartData);
  if (!trend) return null;

  const headline: Headline | null = isHeadline(persisted) ? persisted : computeHeadline(vizConfig as HeadlineSource, rows);
  if (!headline) return null;

  return {
    value: headline.value,
    period: headline.period,
    unit: vizConfig.unit,
    points: trend.points,
    changePct: headline.changePct,
    prevValue: headline.prevValue,
    prevPeriod: headline.prevPeriod,
    basis: headline.basis,
    partial: trend.partialPeriod !== null,
    ...(headline.provisional ? { provisional: true } : {}),
  };
}

/** True when a dataset's chart is a temporal one worth rendering as a mini sparkline on a card. */
export function looksTemporal(vizConfig: VizConfig | null): boolean {
  return vizConfig?.type === "area" || vizConfig?.type === "multi-line";
}

// ---------------------------------------------------------------------------
// Series summary (change badges, peak/trough callouts)
// ---------------------------------------------------------------------------

export interface SeriesPoint {
  period: string;
  value: number;
}

export interface SeriesSummary {
  latest: SeriesPoint | null;
  /** The latest earlier point; `changePct` is measured against it (check `prev.period`: gaps make it non-adjacent). */
  prev: SeriesPoint | null;
  changePct: number | null;
  /** Year grain: vs the prior year. Month grain: vs the same month one year earlier. null when that exact period is absent. */
  yoyPct: number | null;
  min: SeriesPoint | null;
  max: SeriesPoint | null;
  /** True when a partial trailing point was excluded from every figure above. */
  partial: boolean;
}

/**
 * Raw % change. The persisted `vizConfig.headline.changePct` is rounded to 2
 * decimals at sync time, this is not: the two can only disagree in the rounding
 * of the second decimal, which `formatChangePercent` (one decimal) hides except
 * at an exact x.x5 boundary.
 */
function pctChange(from: number, to: number): number | null {
  return from !== 0 && Number.isFinite(from) && Number.isFinite(to) ? ((to - from) / Math.abs(from)) * 100 : null;
}

/** The period one year before `period` on the same grain (null when it cannot be parsed). */
function previousYearPeriod(period: string, grain: Grain): string | null {
  const p = parsePeriod(period);
  if (!p) return null;
  return grain === "year" || p.month === null
    ? String(p.year - 1)
    : `${p.year - 1}-${p.month < 10 ? "0" : ""}${p.month}`;
}

/**
 * Latest value, change vs. the previous point, year-over-year change and the
 * peak/trough of a series. Pass `partial: true` (from `vizConfig.lastPeriodPartial`)
 * to exclude the incomplete trailing point from every figure.
 */
export function summarizeSeries(
  points: ReadonlyArray<TrendPoint>,
  grain: Grain,
  opts: { partial?: boolean } = {},
): SeriesSummary {
  const finite = points.filter((p) => Number.isFinite(p.y) && typeof p.x === "string");
  const partial = Boolean(opts.partial) && finite.length > 0;
  const usable = (partial ? finite.slice(0, -1) : finite).map((p) => ({ period: p.x, value: p.y }));

  const latest = usable[usable.length - 1] ?? null;
  const prev = usable[usable.length - 2] ?? null;

  let yoyPct: number | null = null;
  if (latest) {
    const target = previousYearPeriod(latest.period, grain);
    const base = target === null ? undefined : usable.find((p) => p.period === target);
    if (base) yoyPct = pctChange(base.value, latest.value);
  }

  let min: SeriesPoint | null = null;
  let max: SeriesPoint | null = null;
  for (const p of usable) {
    if (min === null || p.value < min.value) min = p;
    if (max === null || p.value > max.value) max = p;
  }

  return {
    latest,
    prev,
    changePct: latest && prev ? pctChange(prev.value, latest.value) : null,
    yoyPct,
    min,
    max,
    partial,
  };
}

// ---------------------------------------------------------------------------
// Sparkline geometry
// ---------------------------------------------------------------------------

export interface SparklinePaths {
  /** Open polyline path for the stroke; "" when there are fewer than 2 finite points. */
  line: string;
  /** The same polyline closed down to the baseline, for a soft fill. */
  area: string;
}

function fmt(n: number): string {
  return String(Number(n.toFixed(2)));
}

/**
 * SVG path strings for a sparkline in a `w` x `h` box (default the 100 x 40
 * viewBox the Sparkline component uses): evenly spaced in x, scaled to the
 * series' own min/max in y (a flat series sits mid-height), with `pad` of
 * breathing room so a thick stroke is never clipped at the edges.
 * Non-finite points are ignored.
 */
export function sparklinePath(
  points: ReadonlyArray<{ y: number }>,
  w = 100,
  h = 40,
  pad = 2,
): SparklinePaths {
  const ys = points.map((p) => p.y).filter((y) => Number.isFinite(y));
  if (ys.length < 2) return { line: "", area: "" };

  let min = Infinity;
  let max = -Infinity;
  for (const y of ys) {
    if (y < min) min = y;
    if (y > max) max = y;
  }
  const innerW = Math.max(0, w - 2 * pad);
  const innerH = Math.max(0, h - 2 * pad);
  const span = max - min;

  const coords = ys.map((y, i) => {
    const x = pad + (i * innerW) / (ys.length - 1);
    const yy = span === 0 ? h / 2 : pad + innerH - ((y - min) / span) * innerH;
    return [x, yy] as const;
  });

  const line = coords.map(([x, y], i) => `${i === 0 ? "M" : "L"}${fmt(x)} ${fmt(y)}`).join(" ");
  const first = coords[0];
  const last = coords[coords.length - 1];
  const area = `${line} L${fmt(last[0])} ${fmt(h)} L${fmt(first[0])} ${fmt(h)} Z`;
  return { line, area };
}

// ---------------------------------------------------------------------------
// Caption
// ---------------------------------------------------------------------------

const GRAIN_AR: Record<Grain, string> = { year: "سنة", month: "شهر" };
/** The default label of the synthetic "rest" bucket (see OTHER_LABEL in src/lib/chart-model.ts). */
const OTHER_BUCKET_LABEL = "أخرى";

function aggregateWordAr(aggregate: string | undefined): string {
  if (aggregate === "mean") return "متوسط";
  if (aggregate === "last") return "آخر قيمة مسجلة لـ";
  return "مجموع";
}

/** "Area (km2)" with unit "km2" must not become "Area (km2) (km2)". */
function measureWithUnit(label: string, unit: string | undefined): string {
  if (!unit || label.includes(`(${unit})`) || label.includes(`[${unit}]`)) return label;
  return `${label} (${unit})`;
}

export interface ChartCaptionParts {
  /** What the plotted number is: "مجموع X حسب شهر". Empty for tables. */
  title: string;
  /** Qualifiers worth a footnote: aggregated dimensions, excluded totals, partial period, mean warning... */
  notes: string[];
}

const countFormatter = new Intl.NumberFormat("en-US");

/** The label of a chart's synthetic "rest" bucket: a persisted override, else the default. */
function otherLabelOf(vizConfig: VizConfig): string {
  const label = "otherLabel" in vizConfig ? vizConfig.otherLabel : undefined;
  return typeof label === "string" && label !== "" ? label : OTHER_BUCKET_LABEL;
}

/** Why a multi-series temporal chart states no single number (the reason is persisted next to `headline: null`). */
const WITHHELD_NOTE_AR: Partial<Record<string, string>> = {
  "mixed-series": "السلاسل المعروضة مؤشرات مختلفة لا يصح جمعها، لذا لا يُعرض رقم واحد",
  "ambiguous-total": "أكثر من سلسلة إجمالية، لذا لا يُعرض رقم واحد",
  overflow: "السلاسل المعروضة جزء من مجموعها، لذا لا يُعرض رقم إجمالي واحد",
};

/** The pieces of `chartCaption`, for UIs that style the title and the notes separately. */
export function chartCaptionParts(vizConfig: VizConfig | null): ChartCaptionParts {
  if (!vizConfig || vizConfig.type === "table") return { title: "", notes: [] };
  const notes: string[] = [];
  const other = otherLabelOf(vizConfig);
  const isMean = "aggregate" in vizConfig && vizConfig.aggregate === "mean";

  const hidden = "hiddenDimensions" in vizConfig ? vizConfig.hiddenDimensions : undefined;
  if (hidden && hidden.length > 0) notes.push(`مجمّع عبر: ${hidden.join("، ")}`);

  const used = "usedTotals" in vizConfig ? vizConfig.usedTotals : undefined;
  if (used && used.length > 0) notes.push(`القيم هي الإجمالي المنشور («${used.join("»، «")}») لا متوسط الأجزاء`);

  const excluded = "excludedTotals" in vizConfig ? vizConfig.excludedTotals : undefined;
  if (excluded && excluded.length > 0) {
    const rows = `استُبعدت صفوف «${excluded.join("»، «")}»`;
    const unweighted = "unweightedMean" in vizConfig && vizConfig.unweightedMean === true;
    // Nothing is double counted in a mean: the honest reason is that the parts were averaged without weights.
    notes.push(
      !isMean
        ? `${rows} لتفادي العدّ المزدوج`
        : unweighted
          ? `${rows}؛ المتوسط غير مرجّح لأن الإجمالي المنشور غير متوفر لكل الفترات`
          : rows,
    );
  }

  if (vizConfig.type === "histogram") {
    return { title: `توزيع ${measureWithUnit(vizConfig.measureLabel, vizConfig.unit)}`, notes };
  }

  const agg = aggregateWordAr(vizConfig.aggregate);
  const measure = measureWithUnit(vizConfig.measureLabel, vizConfig.unit);
  if (isMean) notes.push("القيم متوسطات وليست مجاميع قابلة للجمع");

  const escapes = "seriesKeyEscapes" in vizConfig ? vizConfig.seriesKeyEscapes : undefined;
  if (escapes && escapes.length > 0) notes.push("أُعيدت تسمية بعض السلاسل لأن أسماءها محجوزة للرسم");

  let title: string;
  if (vizConfig.type === "area" || vizConfig.type === "multi-line") {
    if (vizConfig.type === "area") {
      title = `${agg} ${measure} حسب ${GRAIN_AR[vizConfig.grain]}`;
    } else {
      title = `${agg} ${measure} حسب ${GRAIN_AR[vizConfig.grain]}، موزعاً حسب ${vizConfig.seriesLabel}`;
      if (vizConfig.totalKey) notes.push(`«${vizConfig.totalKey}» خط مستقل ولا يُجمع مع أجزائه`);
      if (vizConfig.seriesOverflow) notes.push(`يُعرض أعلى ${vizConfig.seriesValues.length} فئات فقط`);
    }
    if (vizConfig.lastPeriodPartial) notes.push("الفترة الأخيرة غير مكتملة");
    const withheld =
      vizConfig.headline === null && vizConfig.headlineWithheld ? WITHHELD_NOTE_AR[vizConfig.headlineWithheld] : undefined;
    if (withheld) notes.push(withheld);
    const provisional = vizConfig.provisionalPeriods;
    if (provisional && provisional.length > 0) {
      notes.push(`بيانات ${provisional.slice(-3).map(formatPeriodAr).join("، ")} أولية`);
    }
    if (vizConfig.droppedPeriodRows) {
      notes.push(`صفوف استُبعدت لأن تاريخها غير مفهوم: ${countFormatter.format(vizConfig.droppedPeriodRows)}`);
    }
    if (vizConfig.supersededProvisionalRows) {
      notes.push(
        `صفوف أولية استُبعدت لأن للفترة نفسها صفوفاً نهائية: ${countFormatter.format(vizConfig.supersededProvisionalRows)}`,
      );
    }
  } else if (vizConfig.type === "bar-h") {
    title = `${agg} ${measure} حسب ${vizConfig.dimensionLabel}`;
    if (vizConfig.otherBucketed) notes.push(`تُعرض أعلى الفئات وتُجمع البقية ضمن «${other}»`);
  } else {
    title = `${agg} ${measure} حسب ${vizConfig.xLabel} و ${vizConfig.seriesLabel}`;
    if (vizConfig.stacked === false) notes.push("أعمدة متجاورة وليست متراكمة");
    if (vizConfig.otherSeriesBucketed) notes.push(`بقية السلاسل مجمّعة ضمن «${other}»`);
    else if (vizConfig.seriesOverflow) notes.push(`يُعرض أعلى ${vizConfig.seriesValues.length} فئات فقط`);
    if (vizConfig.otherBucketed) notes.push(`تُعرض أعلى الفئات وتُجمع البقية ضمن «${other}»`);
  }
  return { title, notes };
}

/**
 * One Arabic caption sentence for a chart, built from what `derived.ts`
 * persisted in `vizConfig`: the aggregate (sum / average / latest), the
 * measure and its unit, the grain or the dimensions, and the caveats
 * (aggregated dimensions, excluded totals, mean series, partial last
 * period). "" for table configs and null.
 */
export function chartCaption(vizConfig: VizConfig | null): string {
  const { title, notes } = chartCaptionParts(vizConfig);
  if (!title) return "";
  return [title, ...notes].join(". ") + ".";
}
