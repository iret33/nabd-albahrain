"use client";

import dynamic from "next/dynamic";
import { useCallback, useMemo, useRef, useState } from "react";
import type { VizConfig } from "@/lib/sync/derived";
import { canvasSize, partialPeriodOf, seriesSpecs } from "@/lib/chart-model";
import { formatPeriodAr } from "@/lib/headline";
import { ChartLegend } from "@/components/charts/chart-legend";
import { ChartToolbar } from "@/components/charts/chart-toolbar";

/**
 * Recharts is ~120 KB gzipped and only this one page draws a big chart, so it
 * is loaded on demand (`ssr: false`: the server cannot measure a container
 * anyway, and ResponsiveContainer used to render nothing there). Everything
 * that must be visible immediately is rendered by THIS module, which never
 * imports Recharts: the legend, the download buttons, the unit note and a
 * placeholder box. The placeholder has the chart's exact final height
 * (`canvasSize`), so the chart pops in with no layout shift.
 *
 * The legend's hidden-series state lives here and is handed to the chart.
 */
function ChartSkeleton() {
  return (
    <div className="h-full w-full animate-pulse rounded-md bg-line-light/70" role="status">
      <span className="sr-only">جارٍ تحميل الرسم البياني…</span>
    </div>
  );
}

const LazyChart = dynamic(() => import("@/components/charts/dataset-chart").then((m) => m.DatasetChart), {
  ssr: false,
  loading: () => <ChartSkeleton />,
});

/** Types whose value axis is the vertical one; the unit note sits at its top. */
const VERTICAL_VALUE_AXIS = new Set(["area", "multi-line", "bar-stacked"]);

export function ChartLoader({
  datasetId,
  vizConfig,
  chartData,
  color,
  ariaLabel,
  title,
  notes,
}: {
  datasetId: string;
  vizConfig: VizConfig;
  chartData: unknown[];
  color: string;
  /** Accessible name of the chart: the caption plus the dataset's summary sentence. */
  ariaLabel: string;
  /** What is plotted (the caption title); also the SVG <title> and the PNG header. */
  title: string;
  /** Caption notes (aggregated dimensions, partial period, ...), printed on the PNG. */
  notes: string[];
}) {
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  const canvasRef = useRef<HTMLDivElement>(null);

  const specs = useMemo(() => seriesSpecs(vizConfig, color), [vizConfig, color]);
  const size = canvasSize(vizConfig, chartData.length);
  const rows = chartData as Array<Record<string, unknown>>;
  const partialPeriod = partialPeriodOf(vizConfig, rows);
  const unit = "unit" in vizConfig ? vizConfig.unit : undefined;
  const allHidden = specs.length > 0 && specs.every((s) => hidden.has(s.key));
  const bars = vizConfig.type === "bar-stacked" || vizConfig.type === "bar-h" || vizConfig.type === "histogram";

  const toggle = useCallback((key: string) => {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        {specs.length > 1 ? <ChartLegend specs={specs} hidden={hidden} bars={bars} onToggle={toggle} /> : <span />}
        <ChartToolbar
          datasetId={datasetId}
          vizConfig={vizConfig}
          chartData={chartData}
          title={title}
          notes={notes}
          specs={specs.filter((s) => !hidden.has(s.key))}
          canvasRef={canvasRef}
        />
      </div>

      <div
        ref={canvasRef}
        role="group"
        aria-label={ariaLabel}
        dir="ltr"
        className={`tabular-figures relative mt-4 w-full ${size.className}`}
        style={size.height ? { height: size.height } : undefined}
      >
        <LazyChart vizConfig={vizConfig} chartData={chartData} color={color} hidden={hidden} title={title} />
        {/* Only without JavaScript: the picture needs it, the numbers do not (the table below is server-rendered). */}
        <noscript>
          <p
            dir="rtl"
            className="absolute inset-0 flex items-center justify-center px-6 text-center text-sm leading-7 text-ink/80"
          >
            يتطلب الرسم البياني تفعيل JavaScript — بياناته كاملة في «عرض بيانات الرسم كجدول» أدناه.
          </p>
        </noscript>
        {unit && VERTICAL_VALUE_AXIS.has(vizConfig.type) && (
          <span
            dir="rtl"
            className="pointer-events-none absolute left-0 top-0 text-xs text-ink/80"
          >
            الوحدة: <bdi className="tabular-figures">{unit}</bdi>
          </span>
        )}
        {allHidden && (
          <p
            role="status"
            dir="rtl"
            className="absolute inset-x-0 top-1/2 -translate-y-1/2 text-center text-sm text-ink/80"
          >
            كل السلاسل مخفية — اضغط على اسم سلسلة في الدليل لإظهارها.
          </p>
        )}
      </div>

      {unit && !VERTICAL_VALUE_AXIS.has(vizConfig.type) && (
        <p className="mt-2 text-xs text-ink/80">
          وحدة المحور الأفقي: <bdi className="tabular-figures">{unit}</bdi>
        </p>
      )}
      {partialPeriod && (
        <p className="mt-2 flex items-start gap-2 text-xs leading-5 text-ink/80">
          <svg width="26" height="8" viewBox="0 0 26 8" aria-hidden="true" focusable="false" className="mt-1.5 shrink-0">
            <line x1="0" y1="4" x2="26" y2="4" stroke="currentColor" strokeWidth="2" strokeDasharray="5 4" />
          </svg>
          <span>
            الفترة الأخيرة (<bdi className="tabular-figures">{formatPeriodAr(partialPeriod)}</bdi>) غير مكتملة، لذلك تظهر بخط
            متقطع ولا تُحسب في الأرقام الملخّصة.
          </span>
        </p>
      )}
    </div>
  );
}
