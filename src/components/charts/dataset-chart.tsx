"use client";

import { useId } from "react";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  LineChart,
  Line,
  BarChart,
  Bar,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from "recharts";
import type { VizConfig } from "@/lib/sync/derived";
import { formatCompactAr, formatPeriodLabelAr, formatPeriodTickAr, stripBidiMarks } from "@/lib/format";
import { formatDisplayNumber } from "@/lib/headline";
import {
  DOT_THRESHOLD,
  OTHER_LABEL,
  OTHER_SERIES_COLOR,
  PARTIAL_SUFFIX,
  axisNumberFormatter,
  categoryAxisWidth,
  isolatedIndices,
  partialPeriodOf,
  seriesSpecs,
  splitPartial,
  truncateLabel,
  valueAxisWidth,
  valueExtent,
  type SeriesSpec,
  type ValueExtent,
} from "@/lib/chart-model";

/**
 * The Recharts side of the dataset chart. Loaded lazily (see
 * `chart-loader.tsx`), which also owns the legend, the toolbar and the box this
 * fills; this module only draws.
 *
 * What it does on purpose:
 *  - Gaps stay gaps: `null` periods (missing data) are never bridged
 *    (no `connectNulls`), lines are straight (`linear`) so nothing is
 *    interpolated, and every point gets a dot on series of <= 24 points
 *    (otherwise only points that would be invisible, isolated between gaps).
 *  - A partial trailing period is drawn as a dashed twin series that starts at
 *    the last complete point.
 *  - Value axes use compact Arabic numbers ("1.5 مليون", not "1.5M") and are as
 *    wide as their longest tick; month periods are drawn as "سبتمبر 2022" (the
 *    data keeps the ISO key "2022-09"); the legend (outside) decides which
 *    series are drawn.
 *  - `accessibilityLayer` on every chart: the SVG becomes keyboard focusable and
 *    arrow keys step through the points, showing the tooltip. The data table
 *    under the chart is the full text alternative.
 *  - The canvas is `dir="ltr"` (set by the loader) so time axes read left to
 *    right; the tooltip is forced back to RTL Arabic.
 */

interface TooltipPayloadItem {
  dataKey?: string | number;
  name?: string | number;
  value?: number | string | Array<number | string>;
  color?: string;
  stroke?: string;
  fill?: string;
}

interface RtlTooltipProps {
  active?: boolean;
  payload?: TooltipPayloadItem[];
  label?: string | number;
  unit?: string;
}

/**
 * Custom tooltip forced RTL/Arabic regardless of the canvas's own dir="ltr".
 * The dashed partial-period twin of a series is folded back into that series
 * (and marked "غير مكتملة"), so a series never shows up twice.
 */
function RtlTooltip({ active, payload, label, unit }: RtlTooltipProps) {
  if (!active || !payload || payload.length === 0) return null;

  const merged = new Map<string, TooltipPayloadItem & { partial: boolean }>();
  for (const entry of payload) {
    if (entry.value === null || entry.value === undefined) continue;
    const key = String(entry.dataKey ?? entry.name ?? "");
    const partial = key.endsWith(PARTIAL_SUFFIX);
    const base = partial ? key.slice(0, -PARTIAL_SUFFIX.length) : key;
    const existing = merged.get(base);
    if (!existing || (existing.partial && !partial)) merged.set(base, { ...entry, partial });
  }
  const entries = Array.from(merged.values());
  if (entries.length === 0) return null;
  const periodLabel = label === undefined ? "" : formatPeriodLabelAr(label);

  return (
    <div
      dir="rtl"
      role="status"
      aria-live="polite"
      className="rounded-lg border border-line-light bg-white/95 px-3 py-2 text-xs shadow-lg backdrop-blur"
    >
      {label !== undefined && (
        <p className="mb-1 font-medium text-ink/80">
          {/* A month key ("2022-09") reads "سبتمبر 2022", in this RTL box; any other label keeps its own LTR run. */}
          <span dir={periodLabel === String(label) ? "ltr" : "rtl"} className="tabular-figures">
            {periodLabel}
          </span>
        </p>
      )}
      <ul className="space-y-1">
        {entries.map((entry) => (
          <li key={String(entry.dataKey)} className="flex items-center gap-2">
            <span
              className="inline-block h-2 w-2 shrink-0 rounded-full"
              style={{ background: entry.color ?? entry.stroke ?? entry.fill }}
            />
            <span className="text-ink/80">
              <bdi>{entry.name}</bdi>
              {entry.partial && " (غير مكتملة)"}
            </span>
            <span dir="ltr" className="tabular-figures font-semibold text-ink">
              {typeof entry.value === "number" ? formatDisplayNumber(entry.value) : String(entry.value ?? "")}
              {unit ? ` ${unit}` : ""}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Value-axis tick formatter. From 1,000 up the numbers use Arabic units ("8 آلاف", "1.5 مليون",
 * "60 مليار"; `formatCompactAr`) instead of the Latin "8K"/"1.5M"/"60B" a general Arab reader may
 * not parse; below that, `axisNumberFormatter` picks just enough decimals that neighbouring ticks
 * never read the same.
 */
function valueAxisFormat(extent: ValueExtent): (n: number) => string {
  const maxAbs = Math.max(Math.abs(extent.min), extent.max);
  return maxAbs >= 1000 ? formatCompactAr : axisNumberFormatter(maxAbs);
}

/** The axis is as wide as its longest label; the invisible direction marks in an Arabic label take no room. */
function axisWidth(format: (n: number) => string, extent: ValueExtent): number {
  return valueAxisWidth((n) => stripBidiMarks(format(n)), extent.min, extent.max);
}

const axisTick = { fontSize: 12, fill: "var(--ink)" };
const gridProps = { stroke: "var(--line-light)", strokeDasharray: "3 3" };
const axisLine = { stroke: "var(--line-light)" };
const PARTIAL_DASH = "5 4";

interface DotProps {
  cx?: number | null;
  cy?: number | null;
  index?: number;
}

/**
 * A dot renderer for one series. `all`: every drawn point. `isolated`: only
 * points whose neighbours are both gaps (a line draws nothing there). `last`:
 * only the final point (the partial twin's end).
 */
function dotRenderer(values: ReadonlyArray<number | null | undefined>, mode: "all" | "isolated" | "last", color: string) {
  const isolated = mode === "isolated" ? isolatedIndices(values) : null;
  const lastIndex = values.length - 1;
  function Dot({ cx, cy, index }: DotProps) {
    const drawn = typeof cx === "number" && typeof cy === "number" && index !== undefined;
    const show =
      drawn &&
      (mode === "all" ||
        (mode === "last" ? index === lastIndex && typeof values[index] === "number" : (isolated?.has(index) ?? false)));
    return show ? (
      <circle key={index} cx={cx as number} cy={cy as number} r={3.5} fill="#ffffff" stroke={color} strokeWidth={2} />
    ) : (
      <g key={index} />
    );
  }
  return Dot;
}

const columnOf = (rows: ReadonlyArray<Record<string, unknown>>, key: string): Array<number | null> =>
  rows.map((r) => (typeof r[key] === "number" && Number.isFinite(r[key] as number) ? (r[key] as number) : null));

interface ChartProps {
  vizConfig: VizConfig;
  rows: Array<Record<string, unknown>>;
  specs: SeriesSpec[];
  visible: SeriesSpec[];
  title: string;
}

function AreaView({ vizConfig, rows, specs, visible, title }: ChartProps) {
  const gradientId = `area-fill-${useId().replace(/:/g, "")}`;
  const spec = specs[0];
  const unit = "unit" in vizConfig ? vizConfig.unit : undefined;
  const partial = partialPeriodOf(vizConfig, rows) !== null;
  const data = partial ? splitPartial(rows, ["value"]) : rows;
  const values = columnOf(data, "value");
  const extent = valueExtent(rows, ["value"], false);
  const format = valueAxisFormat(extent);
  const dots = dotRenderer(values, rows.length <= DOT_THRESHOLD ? "all" : "isolated", spec.color);

  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart accessibilityLayer title={title} data={data} margin={{ top: 24, right: 16, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={spec.color} stopOpacity={0.35} />
            <stop offset="100%" stopColor={spec.color} stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid {...gridProps} vertical={false} />
        <XAxis
          dataKey="period"
          tick={axisTick}
          tickLine={false}
          axisLine={axisLine}
          minTickGap={20}
          interval="preserveStartEnd"
          tickFormatter={formatPeriodTickAr}
        />
        <YAxis
          tick={axisTick}
          tickLine={false}
          axisLine={false}
          width={axisWidth(format, extent)}
          tickFormatter={format}
        />
        <Tooltip content={<RtlTooltip unit={unit} />} />
        {visible.length > 0 && (
          <Area
            type="linear"
            dataKey="value"
            name={spec.label}
            stroke={spec.color}
            strokeWidth={2}
            fill={`url(#${gradientId})`}
            dot={dots}
            activeDot={{ r: 5 }}
            connectNulls={false}
            isAnimationActive={false}
          />
        )}
        {visible.length > 0 && partial && (
          <Area
            type="linear"
            dataKey={`value${PARTIAL_SUFFIX}`}
            name={spec.label}
            stroke={spec.color}
            strokeWidth={2}
            strokeDasharray={PARTIAL_DASH}
            fill="none"
            dot={dotRenderer(columnOf(data, `value${PARTIAL_SUFFIX}`), "last", spec.color)}
            activeDot={{ r: 5 }}
            connectNulls={false}
            isAnimationActive={false}
          />
        )}
      </AreaChart>
    </ResponsiveContainer>
  );
}

function MultiLineView({ vizConfig, rows, visible, title }: ChartProps) {
  const unit = "unit" in vizConfig ? vizConfig.unit : undefined;
  const keys = visible.map((s) => s.key);
  const partial = partialPeriodOf(vizConfig, rows) !== null;
  const data = partial ? splitPartial(rows, keys) : rows;
  const extent = valueExtent(rows, keys, false);
  const format = valueAxisFormat(extent);
  const mode = rows.length <= DOT_THRESHOLD ? "all" : "isolated";

  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart accessibilityLayer title={title} data={data} margin={{ top: 24, right: 16, left: 0, bottom: 0 }}>
        <CartesianGrid {...gridProps} vertical={false} />
        <XAxis
          dataKey="period"
          tick={axisTick}
          tickLine={false}
          axisLine={axisLine}
          minTickGap={20}
          interval="preserveStartEnd"
          tickFormatter={formatPeriodTickAr}
        />
        <YAxis
          tick={axisTick}
          tickLine={false}
          axisLine={false}
          width={axisWidth(format, extent)}
          tickFormatter={format}
        />
        <Tooltip content={<RtlTooltip unit={unit} />} />
        {visible.flatMap((spec) => {
          const lines = [
            <Line
              key={spec.key}
              type="linear"
              dataKey={spec.key}
              name={spec.label}
              stroke={spec.color}
              strokeWidth={spec.total ? 2.5 : 2}
              strokeDasharray={spec.dash}
              dot={dotRenderer(columnOf(data, spec.key), mode, spec.color)}
              activeDot={{ r: 5 }}
              connectNulls={false}
              isAnimationActive={false}
            />,
          ];
          if (partial) {
            const twin = `${spec.key}${PARTIAL_SUFFIX}`;
            lines.push(
              <Line
                key={twin}
                type="linear"
                dataKey={twin}
                name={spec.label}
                stroke={spec.color}
                strokeWidth={spec.total ? 2.5 : 2}
                strokeDasharray={PARTIAL_DASH}
                dot={dotRenderer(columnOf(data, twin), "last", spec.color)}
                activeDot={{ r: 5 }}
                connectNulls={false}
                isAnimationActive={false}
                legendType="none"
              />,
            );
          }
          return lines;
        })}
      </LineChart>
    </ResponsiveContainer>
  );
}

function BarHView({ vizConfig, rows, specs, title }: ChartProps) {
  const spec = specs[0];
  const unit = "unit" in vizConfig ? vizConfig.unit : undefined;
  const extent = valueExtent(rows, ["value"], false);
  const format = valueAxisFormat(extent);
  const labels = rows.map((r) => String(r.category ?? ""));
  // Grey only the synthetic "rest" bucket the derivation added (the flag says it exists; its label
  // is renamed when a REAL category is already called "أخرى", which must keep its normal colour).
  const bucketed = "otherBucketed" in vizConfig && vizConfig.otherBucketed === true;
  const otherLabel = ("otherLabel" in vizConfig ? vizConfig.otherLabel : undefined) ?? OTHER_LABEL;
  const isOtherBucket = (category: unknown) => bucketed && category === otherLabel;
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart accessibilityLayer title={title} data={rows} layout="vertical" margin={{ top: 10, right: 24, left: 8, bottom: 0 }}>
        <CartesianGrid {...gridProps} horizontal={false} />
        <XAxis type="number" tick={axisTick} tickLine={false} axisLine={axisLine} tickFormatter={format} />
        <YAxis
          type="category"
          dataKey="category"
          width={categoryAxisWidth(labels, 26)}
          tick={{ ...axisTick, fontSize: 11 }}
          tickLine={false}
          axisLine={false}
          interval={0}
          tickFormatter={(v: unknown) => truncateLabel(String(v), 26)}
        />
        <Tooltip content={<RtlTooltip unit={unit} />} />
        <Bar dataKey="value" name={spec.label} fill={spec.color} radius={[0, 4, 4, 0]} isAnimationActive={false}>
          {rows.map((row, i) => (
            <Cell key={i} fill={isOtherBucket(row.category) ? OTHER_SERIES_COLOR : spec.color} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

function BarStackedView({ vizConfig, rows, visible, title }: ChartProps) {
  const unit = "unit" in vizConfig ? vizConfig.unit : undefined;
  const stacked = vizConfig.type !== "bar-stacked" || vizConfig.stacked !== false;
  const extent = valueExtent(rows, visible.map((s) => s.key), stacked);
  const format = valueAxisFormat(extent);
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart accessibilityLayer title={title} data={rows} margin={{ top: 24, right: 16, left: 0, bottom: 24 }}>
        <CartesianGrid {...gridProps} vertical={false} />
        <XAxis
          dataKey="category"
          tick={{ ...axisTick, fontSize: 11 }}
          tickLine={false}
          axisLine={axisLine}
          interval={rows.length > 12 ? "preserveStartEnd" : 0}
          angle={-35}
          textAnchor="end"
          height={76}
          tickFormatter={(v: unknown) => truncateLabel(String(v), 16)}
        />
        <YAxis
          tick={axisTick}
          tickLine={false}
          axisLine={false}
          width={axisWidth(format, extent)}
          tickFormatter={format}
        />
        <Tooltip content={<RtlTooltip unit={unit} />} />
        {visible.map((spec) => (
          <Bar
            key={spec.key}
            dataKey={spec.key}
            name={spec.label}
            stackId={stacked ? "stack" : undefined}
            fill={spec.color}
            isAnimationActive={false}
          />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

function HistogramView({ rows, specs, title }: ChartProps) {
  const spec = specs[0];
  const extent = valueExtent(rows, ["count"], false);
  const format = valueAxisFormat(extent);
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart accessibilityLayer title={title} data={rows} margin={{ top: 10, right: 16, left: 0, bottom: 24 }} barCategoryGap={2}>
        <CartesianGrid {...gridProps} vertical={false} />
        <XAxis
          dataKey="bucket"
          tick={{ ...axisTick, fontSize: 10 }}
          tickLine={false}
          axisLine={axisLine}
          interval={0}
          angle={-30}
          textAnchor="end"
          height={50}
        />
        <YAxis
          tick={axisTick}
          tickLine={false}
          axisLine={false}
          width={axisWidth(format, extent)}
          tickFormatter={format}
        />
        <Tooltip content={<RtlTooltip />} />
        <Bar dataKey="count" name={spec.label} fill={spec.color} isAnimationActive={false} />
      </BarChart>
    </ResponsiveContainer>
  );
}

/**
 * Renders the "best" chart for a dataset per its precomputed `vizConfig` +
 * `chartData`, fed as props, never a raw record dump. `hidden` lists the
 * series keys the legend has switched off. Returns null for table configs.
 */
export function DatasetChart({
  vizConfig,
  chartData,
  color,
  hidden,
  title,
}: {
  vizConfig: VizConfig;
  chartData: unknown[];
  color: string;
  hidden: ReadonlySet<string>;
  /** The SVG's accessible title (what is plotted). */
  title: string;
}) {
  const rows = chartData.filter(
    (r): r is Record<string, unknown> => !!r && typeof r === "object" && !Array.isArray(r),
  );
  const specs = seriesSpecs(vizConfig, color);
  const visible = specs.filter((s) => !hidden.has(s.key));
  const props: ChartProps = { vizConfig, rows, specs, visible, title };

  switch (vizConfig.type) {
    case "area":
      return <AreaView {...props} />;
    case "multi-line":
      return <MultiLineView {...props} />;
    case "bar-h":
      return <BarHView {...props} />;
    case "bar-stacked":
      return <BarStackedView {...props} />;
    case "histogram":
      return <HistogramView {...props} />;
    default:
      return null;
  }
}
