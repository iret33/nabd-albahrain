"use client";

import {
  ResponsiveContainer,
  AreaChart,
  Area,
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from "recharts";
import type { VizConfig } from "@/lib/sync/derived";
import { formatNumber } from "@/lib/format";
import { seriesPalette } from "@/lib/theme-colors";

interface TooltipPayloadItem {
  dataKey?: string | number;
  name?: string | number;
  value?: number | string | Array<number | string>;
  color?: string;
}

interface RtlTooltipProps {
  active?: boolean;
  payload?: TooltipPayloadItem[];
  label?: string | number;
  unit?: string;
}

/** Custom tooltip forced RTL/Arabic regardless of the chart canvas's own dir="ltr". */
function RtlTooltip({ active, payload, label, unit }: RtlTooltipProps) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div
      dir="rtl"
      className="rounded-lg border border-line-light bg-white/95 px-3 py-2 text-xs shadow-lg backdrop-blur"
    >
      {label !== undefined && (
        <p className="mb-1 font-medium text-ink/60">
          <span dir="ltr" className="tabular-figures">
            {String(label)}
          </span>
        </p>
      )}
      <ul className="space-y-1">
        {payload
          .filter((entry) => entry.value !== null && entry.value !== undefined)
          .map((entry) => (
            <li key={String(entry.dataKey)} className="flex items-center gap-2">
              <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: entry.color }} />
              <span className="text-ink/70">{entry.name}</span>
              <span dir="ltr" className="tabular-figures font-semibold text-ink">
                {typeof entry.value === "number" ? formatNumber(entry.value) : String(entry.value ?? "")}
                {unit ? ` ${unit}` : ""}
              </span>
            </li>
          ))}
      </ul>
    </div>
  );
}

interface LegendPayloadItem {
  value?: string;
  color?: string;
}

/** Custom legend forced RTL/Arabic — series names stay in their original (source) language. */
function RtlLegend({ payload }: { payload?: LegendPayloadItem[] }) {
  if (!payload || payload.length === 0) return null;
  return (
    <ul dir="rtl" className="mt-3 flex flex-wrap justify-center gap-x-4 gap-y-1 text-xs text-ink/70">
      {payload.map((entry, i) => (
        <li key={entry.value ?? i} className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-full" style={{ background: entry.color }} />
          {entry.value}
        </li>
      ))}
    </ul>
  );
}

const axisTick = { fontSize: 12, fill: "var(--ink)" };
const gridProps = { stroke: "var(--line-light)", strokeDasharray: "3 3" };

/**
 * Renders the "best" chart for a dataset per its precomputed `vizConfig` +
 * `chartData` — fed data as props, never a raw record dump. The plotting
 * canvas is wrapped in dir="ltr" so time axes read left-to-right, but the
 * tooltip/legend are custom components forced to dir="rtl" regardless.
 * Returns null for `vizConfig.type === "table"` — the caller renders a
 * "no chart" note + the records table instead.
 */
export function DatasetChart({
  vizConfig,
  chartData,
  color,
}: {
  vizConfig: VizConfig;
  chartData: unknown[];
  color: string;
}) {
  const data = chartData as Array<Record<string, unknown>>;

  if (vizConfig.type === "area") {
    const gradientId = `area-fill-${color.replace("#", "")}`;
    return (
      <div dir="ltr" className="tabular-figures h-72 w-full sm:h-80">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 10, right: 16, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity={0.35} />
                <stop offset="100%" stopColor={color} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid {...gridProps} vertical={false} />
            <XAxis dataKey="period" tick={axisTick} tickLine={false} axisLine={{ stroke: "var(--line-light)" }} />
            <YAxis tick={axisTick} tickLine={false} axisLine={false} width={48} />
            <Tooltip content={(props) => <RtlTooltip {...props} unit={vizConfig.unit} />} />
            <Area
              type="monotone"
              dataKey="value"
              name={vizConfig.measureLabel}
              stroke={color}
              strokeWidth={2}
              fill={`url(#${gradientId})`}
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    );
  }

  if (vizConfig.type === "multi-line") {
    const palette = seriesPalette(color, vizConfig.seriesValues.length);
    return (
      <div dir="ltr" className="tabular-figures h-72 w-full sm:h-80">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 10, right: 16, left: 0, bottom: 0 }}>
            <CartesianGrid {...gridProps} vertical={false} />
            <XAxis dataKey="period" tick={axisTick} tickLine={false} axisLine={{ stroke: "var(--line-light)" }} />
            <YAxis tick={axisTick} tickLine={false} axisLine={false} width={48} />
            <Tooltip content={(props) => <RtlTooltip {...props} unit={vizConfig.unit} />} />
            <Legend content={(props) => <RtlLegend payload={props.payload as LegendPayloadItem[]} />} />
            {vizConfig.seriesValues.map((s, i) => (
              <Line
                key={s}
                type="monotone"
                dataKey={s}
                name={s}
                stroke={palette[i]}
                strokeWidth={2}
                dot={false}
                connectNulls
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
        {vizConfig.seriesOverflow && (
          <p dir="rtl" className="mt-2 text-center text-xs text-ink/50">
            تم عرض أعلى {vizConfig.seriesValues.length} فئات فقط
          </p>
        )}
      </div>
    );
  }

  if (vizConfig.type === "bar-h") {
    const height = Math.min(560, Math.max(240, data.length * 34));
    return (
      <div dir="ltr" className="tabular-figures w-full" style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} layout="vertical" margin={{ top: 10, right: 24, left: 8, bottom: 0 }}>
            <CartesianGrid {...gridProps} horizontal={false} />
            <XAxis type="number" tick={axisTick} tickLine={false} axisLine={{ stroke: "var(--line-light)" }} />
            <YAxis
              type="category"
              dataKey="category"
              width={150}
              tick={{ ...axisTick, fontSize: 11 }}
              tickLine={false}
              axisLine={false}
            />
            <Tooltip content={(props) => <RtlTooltip {...props} unit={vizConfig.unit} />} />
            <Bar dataKey="value" name={vizConfig.measureLabel} fill={color} radius={[0, 4, 4, 0]} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    );
  }

  if (vizConfig.type === "bar-stacked") {
    const palette = seriesPalette(color, vizConfig.seriesValues.length);
    return (
      <div dir="ltr" className="tabular-figures w-full" style={{ height: Math.min(520, Math.max(280, data.length * 40)) }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 10, right: 16, left: 0, bottom: 24 }}>
            <CartesianGrid {...gridProps} vertical={false} />
            <XAxis
              dataKey="category"
              tick={{ ...axisTick, fontSize: 11 }}
              tickLine={false}
              axisLine={{ stroke: "var(--line-light)" }}
              interval={0}
              angle={-20}
              textAnchor="end"
              height={60}
            />
            <YAxis tick={axisTick} tickLine={false} axisLine={false} width={48} />
            <Tooltip content={(props) => <RtlTooltip {...props} unit={vizConfig.unit} />} />
            <Legend content={(props) => <RtlLegend payload={props.payload as LegendPayloadItem[]} />} />
            {vizConfig.seriesValues.map((s, i) => (
              <Bar key={s} dataKey={s} name={s} stackId="stack" fill={palette[i]} isAnimationActive={false} />
            ))}
          </BarChart>
        </ResponsiveContainer>
        {vizConfig.otherBucketed && (
          <p dir="rtl" className="mt-2 text-center text-xs text-ink/50">
            تشمل فئة «أخرى» بقية العناصر
          </p>
        )}
      </div>
    );
  }

  if (vizConfig.type === "histogram") {
    return (
      <div dir="ltr" className="tabular-figures h-72 w-full sm:h-80">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 10, right: 16, left: 0, bottom: 24 }} barCategoryGap={2}>
            <CartesianGrid {...gridProps} vertical={false} />
            <XAxis
              dataKey="bucket"
              tick={{ ...axisTick, fontSize: 10 }}
              tickLine={false}
              axisLine={{ stroke: "var(--line-light)" }}
              interval={0}
              angle={-30}
              textAnchor="end"
              height={50}
            />
            <YAxis tick={axisTick} tickLine={false} axisLine={false} width={40} />
            <Tooltip content={(props) => <RtlTooltip {...props} />} />
            <Bar dataKey="count" name="العدد" fill={color} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    );
  }

  return null;
}
